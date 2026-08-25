// Every non-final S3 multipart part must be at least 5 MiB (5,242,880 bytes).
// Six decimal MB keeps the size divisible by the 1 MB crypto record while
// staying safely above that hard S3 boundary.
export const ADAPTIVE_MIN_CHUNK = 6_000_000;
// Multipart initialization now happens on the control plane before any bytes
// are sent, so the first data request no longer needs to be artificially tiny.
// 32 MB amortizes the fixed S3/proxy request cost while still producing the
// first visible progress sooner than a normal 50 MB part. It remains aligned
// to the 1 MB E2E record format and above S3's 5 MiB floor.
export const MULTIPART_BOOTSTRAP_CHUNK_SIZE = 32_000_000;
export const ANONYMOUS_MAX_CHUNK = 35_000_000;
export const AUTHENTICATED_MAX_CHUNK = 50_000_000;
// Keep transport chunks aligned to the fixed 1 MB E2E record format. A
// literal 50 MiB value (52,428,800 bytes) would end every transport part with
// a partial crypto record and make the concatenated ciphertext undecodable.
// Keep the former export as the default for internal/legacy callers.
export const ADAPTIVE_MAX_CHUNK = AUTHENTICATED_MAX_CHUNK;
export const ABSOLUTE_MAX_CHUNK = 200_000_000;
export const MAX_S3_PARTS = 9_500;
// One megabyte divides every 5 MB adaptive transport chunk, so records never
// end early at an internal transport boundary. It also keeps slow-download
// time-to-first-decrypted-byte low.
export const E2E_CRYPTO_RECORD_SIZE = 1_000_000;

// Keep roughly three seconds of measured bandwidth in a transport chunk.
// Continuously-filled S3 lanes amortize the fixed request cost, while the
// selected profile ceiling bounds browser memory and WAF request size.
const TARGET_CHUNK_SECONDS = 3;
const CHUNK_QUANT = 1_000_000;
const PROBE_SMALL_BYTES = 256_000;
const PROBE_LARGE_BYTES = 8_000_000;
const MAX_REASONABLE_PROBE_BPS = 250_000_000;

export type UploadDeviceCapabilities = {
  deviceMemoryGb: number;
  hardwareConcurrency: number;
};

export type UploadChunkLayout = {
  initialChunkSize: number;
  totalChunks: number;
};

/**
 * Resolve the authoritative variable-size multipart layout.
 *
 * Multipart files start with one part up to 32 MB, followed by normal-sized
 * parts. Slow-link profiles whose normal part is below 32 MB simply use their
 * normal size for the first part. Single-part files keep their configured
 * chunk size. The Worker mirrors these bounds and validates totalChunks before
 * reading any file bytes.
 */
export function getUploadChunkLayout(
  fileSize: number,
  chunkSize: number,
): UploadChunkLayout {
  if (
    !Number.isSafeInteger(fileSize) ||
    fileSize < 0 ||
    !Number.isSafeInteger(chunkSize) ||
    chunkSize <= 0
  ) {
    throw new RangeError("Invalid upload chunk layout");
  }

  if (fileSize <= chunkSize) {
    return { initialChunkSize: chunkSize, totalChunks: 1 };
  }
  if (chunkSize < ADAPTIVE_MIN_CHUNK) {
    throw new RangeError("Multipart chunk size is below the S3 minimum");
  }

  const initialChunkSize = Math.min(MULTIPART_BOOTSTRAP_CHUNK_SIZE, chunkSize);
  return {
    initialChunkSize,
    totalChunks: 1 + Math.ceil((fileSize - initialChunkSize) / chunkSize),
  };
}

export type UploadSchedulingProfile = {
  mode: "bridge-serial" | "server-managed" | "single-part";
  fileConcurrency: number;
  maxParallelLanes: number;
};

const TOTAL_BROWSER_LANE_BUDGET = 6;
const SERVER_MANAGED_PROTOCOL_LANE_LIMIT = 32;
const SERVER_MANAGED_FILE_WORKER_LIMIT = 8;

export type UploadChunkProfile = {
  isAuthenticated: boolean;
  deviceMemoryGb?: number;
  hardwareConcurrency?: number;
};

export type UploadChunkProfileName = "anonymous" | "authenticated";

export function getUploadChunkProfile({
  isAuthenticated,
}: UploadChunkProfile): UploadChunkProfileName {
  return isAuthenticated ? "authenticated" : "anonymous";
}

export function getUploadChunkSizeLimit(profile: UploadChunkProfile): number {
  const resolvedProfile = getUploadChunkProfile(profile);
  if (resolvedProfile === "anonymous") return ANONYMOUS_MAX_CHUNK;
  return AUTHENTICATED_MAX_CHUNK;
}

const RUNTIME_UPLOAD_CHUNK_CONFIG_KEYS: Record<UploadChunkProfileName, string> =
  {
    anonymous: "runtime.uploadAnonymousMaxChunkBytes",
    authenticated: "runtime.uploadAuthenticatedMaxChunkBytes",
  };

export function getRuntimeUploadChunkConfigKey(
  profile: UploadChunkProfileName,
): string {
  return RUNTIME_UPLOAD_CHUNK_CONFIG_KEYS[profile];
}

export function clampUploadChunkSizeLimit(
  profileMaxChunkSize: number,
  runtimeMaxChunkSize: unknown,
): number {
  const parsedRuntimeMax =
    typeof runtimeMaxChunkSize === "number"
      ? runtimeMaxChunkSize
      : Number.parseInt(String(runtimeMaxChunkSize), 10);

  // Older backends do not expose the runtime cap. Keep the compiled profile
  // default in that case so rolling upgrades remain backward compatible.
  if (
    !Number.isFinite(parsedRuntimeMax) ||
    parsedRuntimeMax < ADAPTIVE_MIN_CHUNK
  ) {
    return Math.min(
      ABSOLUTE_MAX_CHUNK,
      Math.max(ADAPTIVE_MIN_CHUNK, profileMaxChunkSize),
    );
  }

  // On a current backend, /api/configs publishes the already-resolved
  // min(global ceiling, authenticated profile ceiling). Treat that value as
  // authoritative rather than capping it again with a 50 MB compile-time
  // default; otherwise raising the instance configuration had no effect in
  // tabs using the new color. The non-configurable 200 MB protocol
  // ceiling remains the browser's final memory-safety guard.
  return Math.min(ABSOLUTE_MAX_CHUNK, Math.floor(parsedRuntimeMax));
}

export function getUploadDeviceCapabilities(): UploadDeviceCapabilities {
  if (typeof navigator === "undefined") {
    return { deviceMemoryGb: 0, hardwareConcurrency: 2 };
  }
  const memoryNavigator = navigator as Navigator & { deviceMemory?: number };
  const reportedMemory = memoryNavigator.deviceMemory;
  return {
    deviceMemoryGb:
      Number.isFinite(reportedMemory) && (reportedMemory ?? 0) > 0
        ? reportedMemory!
        : 0,
    hardwareConcurrency: Math.max(1, navigator.hardwareConcurrency || 2),
  };
}

/**
 * Select only the number of file Workers the local hardware can sustain.
 *
 * Network lane allocation belongs to the server and changes after every part.
 * The 32-lane value is merely the protocol fail-safe used if a compromised
 * server emits an absurd window; the Worker derives a lower memory/CPU ceiling
 * from the browser at runtime. Bridge imports remain serial because they use a
 * separate server-side job scheduler.
 */
export function getUploadSchedulingProfile(
  fileSizes: readonly number[],
  _chunkSizes: number | readonly number[],
  _maxSmallFileConcurrency: number,
  forceSerial = false,
  deviceCapabilities = getUploadDeviceCapabilities(),
): UploadSchedulingProfile {
  if (fileSizes.length === 0) {
    return {
      mode: forceSerial ? "bridge-serial" : "single-part",
      fileConcurrency: 1,
      maxParallelLanes: 1,
    };
  }

  if (forceSerial) {
    return {
      mode: "bridge-serial",
      fileConcurrency: 1,
      maxParallelLanes: TOTAL_BROWSER_LANE_BUDGET,
    };
  }

  const memoryWorkerCap =
    deviceCapabilities.deviceMemoryGb > 0
      ? Math.max(1, Math.floor(deviceCapabilities.deviceMemoryGb / 2))
      : Math.max(2, Math.ceil(deviceCapabilities.hardwareConcurrency / 2));
  const cpuWorkerCap = Math.max(
    1,
    Math.ceil(deviceCapabilities.hardwareConcurrency / 2),
  );
  const fileConcurrency = Math.min(
    fileSizes.length,
    SERVER_MANAGED_FILE_WORKER_LIMIT,
    memoryWorkerCap,
    cpuWorkerCap,
  );
  return {
    mode: "server-managed",
    fileConcurrency: Math.max(1, fileConcurrency),
    maxParallelLanes: SERVER_MANAGED_PROTOCOL_LANE_LIMIT,
  };
}

export function selectRepresentativeProbeBandwidth(
  smallProbeBytesPerSecond: number,
  largeProbeBytesPerSecond: number,
): number {
  const validSmall =
    Number.isFinite(smallProbeBytesPerSecond) && smallProbeBytesPerSecond > 0
      ? smallProbeBytesPerSecond
      : 0;
  const validLarge =
    Number.isFinite(largeProbeBytesPerSecond) && largeProbeBytesPerSecond > 0
      ? largeProbeBytesPerSecond
      : 0;
  let differential = 0;

  // A WAF/proxy can add a nearly fixed delay to every request. Dividing the
  // 8 MB payload by its full duration then turns a 1 Gbps link into an
  // apparent ~30 MB/s link. The slope between the two probe sizes removes
  // that common fixed cost:
  //   B ~= (largeBytes - smallBytes) / (largeTime - smallTime)
  if (validSmall > 0 && validLarge > 0) {
    const smallSeconds = PROBE_SMALL_BYTES / validSmall;
    const largeSeconds = PROBE_LARGE_BYTES / validLarge;
    const transferSeconds = largeSeconds - smallSeconds;
    if (Number.isFinite(transferSeconds) && transferSeconds > 0.001) {
      differential = (PROBE_LARGE_BYTES - PROBE_SMALL_BYTES) / transferSeconds;
    }
  }

  return Math.min(
    MAX_REASONABLE_PROBE_BPS,
    Math.max(validSmall, validLarge, differential),
  );
}

export function computeAdaptiveChunkSize(
  bandwidthBps: number,
  adaptiveMaxChunkSize = ADAPTIVE_MAX_CHUNK,
): number {
  if (bandwidthBps <= 0) return 0;
  const safeAdaptiveMax = Math.min(
    ABSOLUTE_MAX_CHUNK,
    Math.max(ADAPTIVE_MIN_CHUNK, adaptiveMaxChunkSize),
  );
  const raw = bandwidthBps * TARGET_CHUNK_SECONDS;
  const clamped = Math.min(safeAdaptiveMax, Math.max(ADAPTIVE_MIN_CHUNK, raw));
  return Math.round(clamped / CHUNK_QUANT) * CHUNK_QUANT;
}

export function computeEffectiveChunkSize(
  baseChunkSize: number,
  bandwidthBps: number,
  fileSize?: number,
  adaptiveMaxChunkSize = ADAPTIVE_MAX_CHUNK,
  absoluteMaxChunkSize = ABSOLUTE_MAX_CHUNK,
): number {
  const safeAbsoluteMax = Math.min(
    ABSOLUTE_MAX_CHUNK,
    Math.max(ADAPTIVE_MIN_CHUNK, absoluteMaxChunkSize),
  );
  const safeAdaptiveMax = Math.min(
    safeAbsoluteMax,
    Math.max(ADAPTIVE_MIN_CHUNK, adaptiveMaxChunkSize),
  );
  const hardCapped = Math.min(baseChunkSize, safeAdaptiveMax);
  const adaptive = computeAdaptiveChunkSize(bandwidthBps, safeAdaptiveMax);
  let result = adaptive <= 0 ? hardCapped : adaptive;

  if (fileSize && fileSize > 0) {
    // One S3 part is reserved for the 32 MB bootstrap. The remaining bytes
    // must fit in at most MAX_S3_PARTS - 1 normal parts.
    const normalPartBytes = Math.max(
      0,
      fileSize - MULTIPART_BOOTSTRAP_CHUNK_SIZE,
    );
    const s3Floor = Math.ceil(normalPartBytes / (MAX_S3_PARTS - 1));
    if (s3Floor > result) {
      result = Math.ceil(s3Floor / CHUNK_QUANT) * CHUNK_QUANT;
    }
  }

  return Math.min(safeAbsoluteMax, Math.max(ADAPTIVE_MIN_CHUNK, result));
}
