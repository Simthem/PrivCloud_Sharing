import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  GetObjectCommandOutput,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  UploadPartCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PrismaService } from "src/prisma/prisma.service";
import { ConfigService } from "src/config/config.service";
import * as crypto from "crypto";
import * as mime from "mime-types";
import contentDisposition from "content-disposition";
import { File } from "./file.service";
import { getArchiveEntryName } from "./file-path.util";
import { Readable } from "stream";
import { isIP } from "net";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Agent as HttpAgent } from "http";
import { Agent as HttpsAgent } from "https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { validate as isValidUUID } from "uuid";
import { Prisma } from "@prisma/client";
import { createZipArchive } from "../utils/archive.util";
import { getUploadRequestStartedAt } from "./upload-timing.util";
import {
  AdaptiveTransferScheduler,
  TransferSchedulerAllocation,
} from "./adaptive-transfer-scheduler";

const S3_MIN_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
const DEFAULT_DOWNLOAD_PART_BYTES = 16 * 1024 * 1024;
const DEFAULT_PARALLEL_DOWNLOAD_THRESHOLD_BYTES = 32 * 1024 * 1024;
const DEFAULT_DOWNLOAD_MAX_BUFFER_BYTES = 128 * 1024 * 1024;
const DEFAULT_STALE_MULTIPART_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const MIN_STALE_MULTIPART_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_BROWSER_DIRECT_ENDPOINTS = 4;
const MAX_BROWSER_DIRECT_PART_URLS = 32;

export const S3_DATA_PLANE_REVISION = "multi-origin-direct-v8";

type S3ChecksumCalculation = "WHEN_REQUIRED" | "WHEN_SUPPORTED";
export type BrowserDirectAddressingMode = "path" | "virtual-host" | "dual";
type BrowserDirectCandidateAddressingMode = Exclude<
  BrowserDirectAddressingMode,
  "dual"
>;

export interface BrowserDirectTransferCandidate {
  url: string;
  origin: string;
  addressingMode: BrowserDirectCandidateAddressingMode;
}

export interface S3TransportDiagnostics {
  revision: string;
  initialized: boolean;
  route: "direct" | "proxy" | "uninitialized";
  requestChecksum: S3ChecksumCalculation;
  responseChecksum: S3ChecksumCalculation;
  uploadWireFormat: "content-length" | "aws-chunked-opt-in";
  expectContinue: false;
  browserDirectUpload: boolean;
  browserDirectUploadAddressingMode: BrowserDirectAddressingMode;
  browserDirectUploadOriginCount: number;
  browserDirectUploadConnectionsPerOrigin: number;
  browserDirectUploadMaxConcurrency: number;
  browserDirectUploadExpiresInSeconds: number;
  browserDirectDownload: boolean;
  browserDirectDownloadMaxConcurrency: number;
  browserDirectDownloadPartBytes: number;
  browserDirectDownloadThresholdBytes: number;
  browserDirectDownloadMaxBufferBytes: number;
  browserDirectDownloadExpiresInSeconds: number;
}

export interface BrowserDirectUploadPolicy {
  enabled: boolean;
  expiresInSeconds: number;
  addressingMode: BrowserDirectAddressingMode;
  originCount: number;
  connectionsPerOrigin: number;
  maxConcurrency: number;
}

export interface BrowserDirectDownloadPolicy {
  enabled: boolean;
  expiresInSeconds: number;
  maxConcurrency: number;
  partBytes: number;
  thresholdBytes: number;
  maxBufferBytes: number;
}

const getChecksumCalculation = (
  environmentName:
    | "AWS_REQUEST_CHECKSUM_CALCULATION"
    | "AWS_RESPONSE_CHECKSUM_VALIDATION",
  fallback: S3ChecksumCalculation,
): S3ChecksumCalculation => {
  const configured = process.env[environmentName]?.trim().toUpperCase();
  if (!configured) return fallback;
  if (configured === "WHEN_REQUIRED" || configured === "WHEN_SUPPORTED") {
    return configured;
  }
  throw new Error(`${environmentName} must be WHEN_REQUIRED or WHEN_SUPPORTED`);
};

const getBoundedEnvironmentInteger = (
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

type OpenDownloadRange = {
  response: GetObjectCommandOutput;
  body: Readable;
  release: () => void;
};

type BufferedDownloadOutcome =
  | { ok: true; buffer: Buffer }
  | { ok: false; error: unknown };

type ListedMultipartPart = {
  ETag: string | undefined;
  PartNumber: number;
  Size: number;
};

type BrowserDirectSignerDefinition = {
  endpoint: string | undefined;
  addressingMode: BrowserDirectCandidateAddressingMode;
  expectedOrigin: string;
};

const matchesNoProxyPattern = (hostname: string, pattern: string): boolean => {
  let normalizedPattern = pattern.trim().toLowerCase();
  if (normalizedPattern.startsWith("[")) {
    const closingBracket = normalizedPattern.indexOf("]");
    if (closingBracket > 0) {
      normalizedPattern = normalizedPattern.slice(1, closingBracket);
    }
  } else if (
    normalizedPattern.indexOf(":") === normalizedPattern.lastIndexOf(":")
  ) {
    normalizedPattern = normalizedPattern.replace(/:\d+$/, "");
  }
  if (!normalizedPattern) return false;
  if (normalizedPattern === "*") return true;

  // Both global-agent and the common NO_PROXY syntax accept domain suffixes.
  if (normalizedPattern.startsWith(".")) {
    return (
      hostname === normalizedPattern.slice(1) ||
      hostname.endsWith(normalizedPattern)
    );
  }

  // Keep wildcard support deliberately small and anchored. It covers the
  // private-address pattern used by deployments without treating arbitrary
  // regex metacharacters as executable syntax.
  const expression = normalizedPattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${expression}$`, "i").test(hostname);
};

const endpointBypassesProxy = (endpoint: string, noProxy: string): boolean => {
  if (!endpoint || !noProxy) return false;
  let hostname: string;
  try {
    hostname = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    throw new Error("Invalid S3 endpoint URL");
  }
  return noProxy
    .split(",")
    .some((pattern) => matchesNoProxyPattern(hostname, pattern));
};

@Injectable()
export class S3FileService {
  private readonly logger = new Logger(S3FileService.name);
  private s3Client?: S3Client;
  private s3ClientCacheKey?: string;
  private s3PresignClientCacheKey?: string;
  private s3PresignClients = new Map<string, S3Client>();
  private s3TransportAgent?: HttpAgent | HttpsAgent;
  private s3ProxyConnects = 0;
  private s3ProxyConnectFailures = 0;
  private s3TransportDiagnostics: S3TransportDiagnostics = {
    revision: S3_DATA_PLANE_REVISION,
    initialized: false,
    route: "uninitialized",
    requestChecksum: "WHEN_REQUIRED",
    responseChecksum: "WHEN_REQUIRED",
    uploadWireFormat: "content-length",
    expectContinue: false,
    browserDirectUpload: false,
    browserDirectUploadAddressingMode: "path",
    browserDirectUploadOriginCount: 1,
    browserDirectUploadConnectionsPerOrigin: 6,
    browserDirectUploadMaxConcurrency: 6,
    browserDirectUploadExpiresInSeconds: 300,
    browserDirectDownload: false,
    browserDirectDownloadMaxConcurrency: 6,
    browserDirectDownloadPartBytes: 32 * 1024 * 1024,
    browserDirectDownloadThresholdBytes: 64 * 1024 * 1024,
    browserDirectDownloadMaxBufferBytes: 201_326_592,
    browserDirectDownloadExpiresInSeconds: 900,
  };

  // Keyed by `${operation}:${shareId}:${fileId}`. A Map, not a plain object:
  // the key embeds client-controlled identifiers, and a Map keeps prototype
  // keys (`__proto__`, `constructor`, `prototype`) unreachable by construction.
  private multipartUploads = new Map<
    string,
    {
      uploadId: string;
      parts: ListedMultipartPart[];
      lastActivity: number;
      shareId: string;
      flowId?: string;
      totalParts?: number;
    }
  >();
  private multipartInitializations = new Map<
    string,
    Promise<{
      initialized: boolean;
      initMs: number;
      uploadedParts: Array<{ partNumber: number; size: number }>;
    }>
  >();
  private uploadScheduler?: AdaptiveTransferScheduler;
  private downloadScheduler?: AdaptiveTransferScheduler;

  // TTL for abandoned multipart uploads: no chunk received for 60 min.
  // This is an *inactivity* timeout, not a total duration limit, so
  // multi-hour uploads of very large files (40 GB+) are safe as long
  // as chunks keep arriving.
  // Set to 60 min (was 30 min): the client-side retry logic can spend
  // up to ~38 min retrying a single chunk (20 transient retries with
  // exponential backoff + 3 recovery cycles).  A 30-min TTL could clean
  // up the session while the client is still retrying, causing a
  // "session not found" error that kills the upload permanently.
  private static readonly MULTIPART_TTL_MS = 60 * 60 * 1000;

  private getAdaptiveUploadScheduler(): AdaptiveTransferScheduler {
    this.uploadScheduler ??= new AdaptiveTransferScheduler();
    return this.uploadScheduler;
  }

  private getAdaptiveDownloadScheduler(): AdaptiveTransferScheduler {
    this.downloadScheduler ??= new AdaptiveTransferScheduler({
      environmentKeys: {
        maxSlots: "S3_MAX_CONCURRENT_DOWNLOADS",
        minSlots: "S3_MIN_CONCURRENT_DOWNLOADS",
        maxSlotsPerFlow: "S3_MAX_CONCURRENT_PER_DOWNLOAD",
        queueLimit: "S3_DOWNLOAD_QUEUE_LIMIT",
        slotTimeoutMs: "S3_DOWNLOAD_SLOT_TIMEOUT_MS",
        activeFlowTtlMs: "S3_ACTIVE_DOWNLOAD_TTL_MS",
        reevaluationMs: "S3_DOWNLOAD_ADAPTIVE_REEVALUATION_MS",
        slotMemoryBytes: "S3_DOWNLOAD_SLOT_MEMORY_BYTES",
      },
    });
    return this.downloadScheduler;
  }

  private getUploadFlowId(shareId: string, fileId: string): string {
    return `${shareId}:${fileId}`;
  }

  getUploadAllocation(
    shareId: string,
    fileId: string,
    allowBorrowing = true,
  ): TransferSchedulerAllocation {
    return this.getAdaptiveUploadScheduler().getAllocation(
      this.getUploadFlowId(shareId, fileId),
      { allowBorrowing },
    );
  }

  /**
   * Direct PUT bodies bypass Nest entirely. Their browser window is therefore
   * derived only from the number of independent S3 origins and the safe
   * per-origin connection budget. Relay pressure is advertised separately so
   * a temporary fallback still participates in server-side fairness.
   */
  getBrowserDirectUploadAllocation(
    _shareId: string,
    _fileId: string,
  ): TransferSchedulerAllocation {
    const targetSlots = this.getBrowserDirectUploadPolicy().maxConcurrency;
    return {
      recommendedSlots: targetSlots,
      targetSlots,
      activeSlots: 0,
      activeFlows: 1,
      queuedRequests: 0,
      fairShare: targetSlots,
      memoryPressure: 0,
      cpuPressure: 0,
      eventLoopLagMs: 0,
      pressureSamples: 0,
    };
  }

  unregisterUploadFlow(shareId: string, fileId: string): void {
    this.getAdaptiveUploadScheduler().unregisterFlow(
      this.getUploadFlowId(shareId, fileId),
    );
  }

  private getBrowserDirectAddressingMode(): BrowserDirectAddressingMode {
    const configured = (
      process.env.S3_DIRECT_BROWSER_UPLOAD_ADDRESSING_MODE ?? "path"
    )
      .trim()
      .toLowerCase();
    if (
      configured !== "path" &&
      configured !== "virtual-host" &&
      configured !== "dual"
    ) {
      throw new Error(
        "S3_DIRECT_BROWSER_UPLOAD_ADDRESSING_MODE must be path, virtual-host or dual",
      );
    }
    return configured;
  }

  private isDnsCompatibleBucketName(bucket: string): boolean {
    return (
      bucket.length >= 3 &&
      bucket.length <= 63 &&
      /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket) &&
      !bucket.includes("..") &&
      !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)
    );
  }

  private getBrowserDirectSignerDefinitions(): BrowserDirectSignerDefinition[] {
    const primaryEndpoint = (this.config.get("s3.endpoint") ?? "").trim();
    const configuredEndpoints =
      process.env.S3_DIRECT_BROWSER_UPLOAD_ENDPOINTS ?? "";
    const additionalEndpoints = configuredEndpoints
      ? configuredEndpoints.split(",").map((endpoint) => endpoint.trim())
      : [];
    if (
      additionalEndpoints.some((endpoint) => !endpoint) ||
      additionalEndpoints.length > MAX_BROWSER_DIRECT_ENDPOINTS
    ) {
      throw new Error(
        `S3_DIRECT_BROWSER_UPLOAD_ENDPOINTS must contain at most ${MAX_BROWSER_DIRECT_ENDPOINTS} non-empty HTTPS URLs`,
      );
    }

    const normalizeEndpoint = (
      endpoint: string,
      requireHttps: boolean,
    ): string => {
      let parsed: URL;
      try {
        parsed = new URL(endpoint);
      } catch {
        throw new Error("Invalid direct-browser S3 endpoint URL");
      }
      if (
        (requireHttps && parsed.protocol !== "https:") ||
        (!requireHttps && !["http:", "https:"].includes(parsed.protocol)) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      ) {
        throw new Error(
          requireHttps
            ? "S3_DIRECT_BROWSER_UPLOAD_ENDPOINTS accepts HTTPS URLs without credentials, query or fragment"
            : "Invalid direct-browser S3 endpoint URL",
        );
      }
      parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
      return parsed.toString().replace(/\/$/, "");
    };

    const normalizedPrimaryEndpoint = primaryEndpoint
      ? normalizeEndpoint(primaryEndpoint, false)
      : undefined;
    const endpoints: Array<string | undefined> = [];
    if (primaryEndpoint) {
      endpoints.push(normalizedPrimaryEndpoint);
    }
    for (const endpoint of additionalEndpoints) {
      endpoints.push(normalizeEndpoint(endpoint, true));
    }
    if (endpoints.length === 0) endpoints.push(undefined);

    const uniqueEndpoints = endpoints.filter(
      (endpoint, index) => endpoints.indexOf(endpoint) === index,
    );
    const addressingMode = this.getBrowserDirectAddressingMode();
    const bucket = (this.config.get("s3.bucketName") ?? "").trim();
    const region = (this.config.get("s3.region") ?? "").trim() || "us-east-1";
    const virtualHostCompatible = this.isDnsCompatibleBucketName(bucket);
    if (addressingMode === "virtual-host" && !virtualHostCompatible) {
      throw new Error(
        "Virtual-host S3 addressing requires a DNS-compatible bucket name",
      );
    }

    const definitions: BrowserDirectSignerDefinition[] = [];
    for (const endpoint of uniqueEndpoints) {
      const isPrimaryEndpoint = endpoint === normalizedPrimaryEndpoint;
      const pathOrigin = endpoint
        ? new URL(endpoint).origin
        : `https://s3.${region}.amazonaws.com`;
      if (addressingMode === "path" || addressingMode === "dual") {
        definitions.push({
          endpoint,
          addressingMode: "path",
          expectedOrigin: pathOrigin,
        });
      }
      if (
        isPrimaryEndpoint &&
        virtualHostCompatible &&
        (!endpoint || isIP(new URL(endpoint).hostname) === 0) &&
        (addressingMode === "virtual-host" || addressingMode === "dual")
      ) {
        const virtualOrigin = endpoint
          ? (() => {
              const parsed = new URL(endpoint);
              parsed.hostname = `${bucket}.${parsed.hostname}`;
              return parsed.origin;
            })()
          : `https://${bucket}.s3.${region}.amazonaws.com`;
        definitions.push({
          endpoint,
          addressingMode: "virtual-host",
          expectedOrigin: virtualOrigin,
        });
      }
    }

    if (definitions.length === 0) {
      throw new Error(
        "No browser-direct S3 origin is compatible with the configured addressing mode",
      );
    }

    const seenOrigins = new Set<string>();
    return definitions.filter((definition) => {
      if (seenOrigins.has(definition.expectedOrigin)) return false;
      seenOrigins.add(definition.expectedOrigin);
      return true;
    });
  }

  getBrowserDirectUploadPolicy(): BrowserDirectUploadPolicy {
    const configured = (process.env.S3_DIRECT_BROWSER_UPLOAD_ENABLED ?? "false")
      .trim()
      .toLowerCase();
    if (configured !== "true" && configured !== "false") {
      throw new Error("S3_DIRECT_BROWSER_UPLOAD_ENABLED must be true or false");
    }

    const definitions = this.getBrowserDirectSignerDefinitions();
    const addressingMode = this.getBrowserDirectAddressingMode();
    const originCount = new Set(
      definitions.map((definition) => definition.expectedOrigin),
    ).size;
    const connectionsPerOrigin = getBoundedEnvironmentInteger(
      "S3_DIRECT_BROWSER_CONNECTIONS_PER_ORIGIN",
      6,
      1,
      16,
    );
    const endpoint = (this.config.get("s3.endpoint") ?? "").trim();
    const allowInsecureEndpoint =
      (process.env.S3_DIRECT_BROWSER_ALLOW_HTTP ?? "false")
        .trim()
        .toLowerCase() === "true";
    const endpointCanBeReachedFromSecureBrowsers =
      !endpoint || endpoint.startsWith("https://") || allowInsecureEndpoint;
    return {
      enabled: configured === "true" && endpointCanBeReachedFromSecureBrowsers,
      expiresInSeconds: getBoundedEnvironmentInteger(
        "S3_DIRECT_BROWSER_URL_TTL_SECONDS",
        300,
        60,
        900,
      ),
      addressingMode,
      originCount,
      connectionsPerOrigin,
      maxConcurrency: Math.min(
        getBoundedEnvironmentInteger(
          "S3_DIRECT_BROWSER_MAX_CONCURRENCY",
          32,
          1,
          32,
        ),
        Math.max(1, originCount * connectionsPerOrigin),
      ),
    };
  }

  getBrowserDirectDownloadPolicy(): BrowserDirectDownloadPolicy {
    const configured = (
      process.env.S3_DIRECT_BROWSER_DOWNLOAD_ENABLED ?? "false"
    )
      .trim()
      .toLowerCase();
    if (configured !== "true" && configured !== "false") {
      throw new Error(
        "S3_DIRECT_BROWSER_DOWNLOAD_ENABLED must be true or false",
      );
    }
    const endpoint = (this.config.get("s3.endpoint") ?? "").trim();
    const allowInsecureEndpoint =
      (process.env.S3_DIRECT_BROWSER_ALLOW_HTTP ?? "false")
        .trim()
        .toLowerCase() === "true";
    const partBytes = getBoundedEnvironmentInteger(
      "S3_DIRECT_BROWSER_DOWNLOAD_PART_BYTES",
      32 * 1024 * 1024,
      8 * 1024 * 1024,
      128 * 1024 * 1024,
    );
    const maxBufferBytes = Math.max(
      partBytes,
      getBoundedEnvironmentInteger(
        "S3_DIRECT_BROWSER_DOWNLOAD_MAX_BUFFER_BYTES",
        201_326_592,
        32 * 1024 * 1024,
        512 * 1024 * 1024,
      ),
    );
    const configuredMaxConcurrency = getBoundedEnvironmentInteger(
      "S3_DIRECT_BROWSER_DOWNLOAD_MAX_CONCURRENCY",
      24,
      1,
      32,
    );
    return {
      enabled:
        configured === "true" &&
        (!endpoint || endpoint.startsWith("https://") || allowInsecureEndpoint),
      expiresInSeconds: getBoundedEnvironmentInteger(
        "S3_DIRECT_BROWSER_DOWNLOAD_URL_TTL_SECONDS",
        900,
        60,
        3600,
      ),
      maxConcurrency: Math.min(
        configuredMaxConcurrency,
        Math.max(1, Math.floor(maxBufferBytes / partBytes)),
      ),
      partBytes,
      thresholdBytes: Math.max(
        partBytes * 2,
        getBoundedEnvironmentInteger(
          "S3_DIRECT_BROWSER_DOWNLOAD_THRESHOLD_BYTES",
          64 * 1024 * 1024,
          16 * 1024 * 1024,
          1024 * 1024 * 1024,
        ),
      ),
      maxBufferBytes,
    };
  }

  private async acquireUploadSlot(
    flowId: string,
    timeoutMs?: number,
  ): Promise<boolean> {
    return this.getAdaptiveUploadScheduler().acquire(flowId, timeoutMs);
  }

  private releaseUploadSlot(flowId: string): void {
    try {
      this.getAdaptiveUploadScheduler().release(flowId);
    } catch (error) {
      this.logger.error(
        error instanceof Error ? error.message : "Upload slot underflow",
      );
    }
  }

  /**
   * Returns true when an S3/SDK error indicates the multipart upload
   * session no longer exists on the S3 side.  This is a non-recoverable
   * state: the client must restart the upload from chunk 0.
   */
  private isS3UploadGone(error: any): boolean {
    if (!error) return false;
    // AWS SDK v3: error.name or error.Code set to 'NoSuchUpload'
    if (error.name === "NoSuchUpload" || error.Code === "NoSuchUpload")
      return true;
    // HTTP 404 from S3 on multipart operations usually means the upload is gone
    if (error.$metadata?.httpStatusCode === 404) return true;
    // Fallback: check the message string
    if (
      typeof error.message === "string" &&
      error.message.includes("NoSuchUpload")
    )
      return true;
    return false;
  }

  /**
   * Idempotency check for retried final chunks. Returns true when a DB file
   * record already exists for this (fileId, shareId) pair -- meaning the
   * multipart upload already completed and materialized the file, even if the
   * completion response was lost in transit (proxy/WAF timeout). Used to turn
   * a phantom "session not found" 500 at 100% into a success.
   */
  private async isUploadAlreadyCompleted(
    fileId: string,
    shareId: string,
  ): Promise<boolean> {
    const existing = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: { shareId: true },
    });
    return existing?.shareId === shareId;
  }

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {
    // Periodically clean up abandoned multipart upload sessions
    setInterval(() => this.cleanupAbandonedUploads(), 5 * 60 * 1000);
  }

  private assertSafeStorageSegment(segment: string): void {
    if (!segment || segment === "." || /[\/\\]|\.{2}|\x00/.test(segment)) {
      throw new BadRequestException("Invalid storage identifier");
    }
  }

  private getSharePrefix(shareId: string): string {
    this.assertSafeStorageSegment(shareId);
    return `${this.getS3Path()}${shareId}/`;
  }

  private getShareObjectKey(shareId: string, fileId: string): string {
    this.assertSafeStorageSegment(fileId);
    return `${this.getSharePrefix(shareId)}${fileId}`;
  }

  private getMultipartSessionKey(
    operation: "upload" | "reencrypt",
    shareId: string,
    fileId: string,
  ): string {
    // File IDs are client-provided until the DB record is materialized. Scope
    // in-memory state by share as well, so the same UUID in two authorized
    // shares cannot collide or inherit the other share's multipart upload.
    return `${operation}:${shareId}:${fileId}`;
  }

  private async withMultipartLock<T>(
    shareId: string,
    fileId: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    // The public edition uses SQLite. An interactive write transaction is the
    // portability boundary here: SQLite serializes writers and the object key
    // remains scoped by share and file identifiers.
    return this.prisma.$transaction(
      async (tx) => {
        return operation(tx);
      },
      {
        maxWait: 30_000,
        timeout: 600_000,
      },
    );
  }

  private async listMultipartParts(
    key: string,
    uploadId: string,
  ): Promise<ListedMultipartPart[]> {
    const parts: ListedMultipartPart[] = [];
    let marker: string | undefined;
    let truncated = true;
    while (truncated) {
      const response = await this.getS3Instance().send(
        new ListPartsCommand({
          Bucket: this.config.get("s3.bucketName"),
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      for (const part of response.Parts ?? []) {
        if (
          part.PartNumber &&
          Number.isSafeInteger(part.Size) &&
          (part.Size ?? -1) >= 0
        ) {
          parts.push({
            ETag: part.ETag,
            PartNumber: part.PartNumber,
            Size: part.Size!,
          });
        }
      }
      truncated = !!response.IsTruncated;
      marker = response.NextPartNumberMarker;
    }
    return parts;
  }

  /**
   * Evict only this process' stale multipart cache.
   *
   * A blue process can remain alive while a green process continues the same
   * S3 upload. Aborting from this local TTL would therefore let an old color
   * destroy an upload that is still active elsewhere.
   */
  private async cleanupAbandonedUploads() {
    const now = Date.now();
    for (const [key, upload] of this.multipartUploads) {
      if (now - upload.lastActivity > S3FileService.MULTIPART_TTL_MS) {
        this.logger.warn(
          `Evicting local multipart state: key=${key} uploadId=${upload.uploadId}`,
        );
        if (upload.flowId) {
          this.getAdaptiveUploadScheduler().unregisterFlow(upload.flowId);
        }
        this.multipartUploads.delete(key);
      }
    }
  }

  /**
   * Inspect both this process and S3 itself for recently active multipart
   * uploads. S3 is authoritative across mixed-version workers, including an old
   * application process that does not persist database heartbeats yet.
   */
  async getRecentUploadActivity(
    shareId: string,
    since: Date,
  ): Promise<Date | null> {
    let newest = 0;
    for (const upload of this.multipartUploads.values()) {
      if (upload.shareId === shareId) {
        newest = Math.max(newest, upload.lastActivity);
      }
    }
    if (newest >= since.getTime()) return new Date(newest);

    const s3 = this.getS3Instance();
    const bucket = this.config.get("s3.bucketName");
    const prefix = this.getSharePrefix(shareId);
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    let uploadsTruncated = true;

    while (uploadsTruncated) {
      const listed = await s3.send(
        new ListMultipartUploadsCommand({
          Bucket: bucket,
          Prefix: prefix,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadIdMarker,
        }),
      );

      for (const upload of listed.Uploads ?? []) {
        if (upload.Initiated) {
          newest = Math.max(newest, upload.Initiated.getTime());
        }
        if (newest >= since.getTime()) return new Date(newest);
        if (!upload.Key || !upload.UploadId) continue;

        let partMarker: string | undefined;
        let partsTruncated = true;
        while (partsTruncated) {
          const parts = await s3.send(
            new ListPartsCommand({
              Bucket: bucket,
              Key: upload.Key,
              UploadId: upload.UploadId,
              PartNumberMarker: partMarker,
            }),
          );
          for (const part of parts.Parts ?? []) {
            if (part.LastModified) {
              newest = Math.max(newest, part.LastModified.getTime());
            }
          }
          if (newest >= since.getTime()) return new Date(newest);
          partsTruncated = !!parts.IsTruncated;
          partMarker = parts.NextPartNumberMarker;
        }
      }

      uploadsTruncated = !!listed.IsTruncated;
      keyMarker = listed.NextKeyMarker;
      uploadIdMarker = listed.NextUploadIdMarker;
    }

    return newest >= since.getTime() ? new Date(newest) : null;
  }

  /**
   * Abort all in-memory multipart uploads for a given share.
   * Called when a share is deleted or an upload is cancelled.
   */
  async abortShareMultipartUploads(shareId: string) {
    const s3Instance = this.getS3Instance();
    const bucket = this.config.get("s3.bucketName");

    for (const [key, upload] of this.multipartUploads) {
      if (upload.shareId === shareId) {
        if (upload.flowId) {
          this.getAdaptiveUploadScheduler().unregisterFlow(upload.flowId);
        }
        this.multipartUploads.delete(key);
      }
    }

    // Abort all S3-side multipart uploads under this share's prefix
    const prefix = this.getSharePrefix(shareId);
    try {
      const listResp = await s3Instance.send(
        new ListMultipartUploadsCommand({
          Bucket: bucket,
          Prefix: prefix,
        }),
      );
      if (listResp.Uploads && listResp.Uploads.length > 0) {
        for (const upload of listResp.Uploads) {
          if (upload.Key && upload.UploadId) {
            try {
              await s3Instance.send(
                new AbortMultipartUploadCommand({
                  Bucket: bucket,
                  Key: upload.Key,
                  UploadId: upload.UploadId,
                }),
              );
              this.logger.log(
                `Aborted orphan multipart upload for share ${shareId}: key=${upload.Key}`,
              );
            } catch (e) {
              this.logger.error(
                `Failed to abort multipart upload: key=${upload.Key} error=${e}`,
              );
            }
          }
        }
      }
    } catch (e) {
      this.logger.error(
        `Failed to list multipart uploads for share ${shareId}: ${e}`,
      );
    }

    // Clean in-memory tracking for any fileId matching this share
    // (best-effort: we don't store shareId, so clean all entries whose
    // S3 key starts with this share's prefix)
    // This is already covered by deleting the share, but clean up memory.
  }

  /**
   * Purge all stale S3-side multipart uploads older than the given age.
   * Called periodically from jobs.service.ts to catch any uploads that
   * slipped past the in-memory cleanup (e.g. after a server restart).
   */
  async cleanupStaleS3Multiparts(maxAgeMs?: number) {
    const configuredHours = getBoundedEnvironmentInteger(
      "S3_MULTIPART_STALE_ABORT_HOURS",
      DEFAULT_STALE_MULTIPART_MAX_AGE_MS / 60 / 60 / 1000,
      24,
      24 * 30,
    );
    const effectiveMaxAgeMs = Math.max(
      MIN_STALE_MULTIPART_MAX_AGE_MS,
      Number.isSafeInteger(maxAgeMs) && (maxAgeMs ?? 0) > 0
        ? maxAgeMs!
        : configuredHours * 60 * 60 * 1000,
    );
    const s3Instance = this.getS3Instance();
    const bucket = this.config.get("s3.bucketName");
    const prefix = this.getS3Path();
    const cutoff = new Date(Date.now() - effectiveMaxAgeMs);
    let aborted = 0;

    try {
      let keyMarker: string | undefined;
      let uploadIdMarker: string | undefined;
      let isTruncated = true;

      while (isTruncated) {
        const listResp = await s3Instance.send(
          new ListMultipartUploadsCommand({
            Bucket: bucket,
            Prefix: prefix,
            KeyMarker: keyMarker,
            UploadIdMarker: uploadIdMarker,
          }),
        );

        if (listResp.Uploads) {
          for (const upload of listResp.Uploads) {
            if (
              upload.Initiated &&
              upload.Initiated < cutoff &&
              upload.Key &&
              upload.UploadId
            ) {
              try {
                await s3Instance.send(
                  new AbortMultipartUploadCommand({
                    Bucket: bucket,
                    Key: upload.Key,
                    UploadId: upload.UploadId,
                  }),
                );
                aborted++;
              } catch (e) {
                this.logger.error(
                  `Failed to abort stale multipart: key=${upload.Key} err=${e}`,
                );
              }
            }
          }
        }

        isTruncated = !!listResp.IsTruncated;
        keyMarker = listResp.NextKeyMarker;
        uploadIdMarker = listResp.NextUploadIdMarker;
      }
    } catch (e) {
      this.logger.error(`Failed to list S3 multipart uploads: ${e}`);
    }

    if (aborted > 0) {
      this.logger.log(`Aborted ${aborted} stale S3 multipart uploads`);
    }
  }

  private async recoverMultipartUpload(
    fileId: string,
    shareId: string,
    totalParts: number,
  ): Promise<boolean> {
    if (
      (process.env.S3_MULTIPART_RECOVERY_ENABLED ?? "true")
        .trim()
        .toLowerCase() === "false"
    ) {
      return false;
    }
    const s3 = this.getS3Instance();
    const bucket = this.config.get("s3.bucketName");
    const key = this.getShareObjectKey(shareId, fileId);
    const listed = await s3.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        Prefix: key,
      }),
    );
    const candidates = (listed.Uploads ?? []).filter(
      (upload) => upload.Key === key && !!upload.UploadId,
    );
    if (candidates.length === 0) return false;

    const recoveredCandidates = await Promise.all(
      candidates.map(async (candidate) => ({
        candidate,
        parts: await this.listMultipartParts(key, candidate.UploadId!),
      })),
    );
    recoveredCandidates.sort((left, right) => {
      if (left.parts.length !== right.parts.length) {
        return right.parts.length - left.parts.length;
      }
      return (
        (right.candidate.Initiated?.getTime() ?? 0) -
        (left.candidate.Initiated?.getTime() ?? 0)
      );
    });
    const recovered = recoveredCandidates[0];
    const flowId = this.getUploadFlowId(shareId, fileId);
    this.multipartUploads.set(
      this.getMultipartSessionKey("upload", shareId, fileId),
      {
        uploadId: recovered.candidate.UploadId!,
        parts: recovered.parts,
        lastActivity: Date.now(),
        shareId,
        flowId,
        totalParts,
      },
    );
    this.getAdaptiveUploadScheduler().registerFlow(flowId);
    this.logger.warn(
      `Multipart recovered from S3: shareId=${shareId} fileId=${fileId} ` +
        `parts=${recovered.parts.length}/${totalParts} candidates=${candidates.length}`,
    );
    return true;
  }

  private getUploadedMultipartParts(
    parts: ListedMultipartPart[],
    totalParts: number,
  ): Array<{ partNumber: number; size: number }> {
    return parts
      .filter(
        (part) =>
          part.PartNumber >= 1 &&
          part.PartNumber <= totalParts &&
          Number.isSafeInteger(part.Size) &&
          part.Size >= 0,
      )
      .sort((left, right) => left.PartNumber - right.PartNumber)
      .map((part) => ({
        partNumber: part.PartNumber,
        size: part.Size,
      }));
  }

  private async refreshMultipartParts(
    fileId: string,
    shareId: string,
    upload: {
      uploadId: string;
      parts: ListedMultipartPart[];
      lastActivity: number;
    },
    totalParts: number,
  ): Promise<Array<{ partNumber: number; size: number }>> {
    upload.parts = await this.listMultipartParts(
      this.getShareObjectKey(shareId, fileId),
      upload.uploadId,
    );
    upload.lastActivity = Date.now();
    return this.getUploadedMultipartParts(upload.parts, totalParts);
  }

  /**
   * Create the S3 multipart session before any large request body is sent.
   *
   * A stable client-generated UUID makes this operation idempotent across
   * network retries. Concurrent init calls for the same share/file reuse one
   * promise, so they can never leak two S3 multipart sessions.
   */
  async initializeMultipartUpload(
    file: { id?: string; name: string; relativePath?: string },
    shareId: string,
    totalParts: number,
  ): Promise<{
    id: string;
    initialized: boolean;
    initMs: number;
    uploadedParts: Array<{ partNumber: number; size: number }>;
  }> {
    if (!file.id) file.id = crypto.randomUUID();
    if (!isValidUUID(file.id)) {
      throw new BadRequestException("Invalid file ID format");
    }
    if (
      !Number.isSafeInteger(totalParts) ||
      totalParts < 1 ||
      totalParts > 10_000
    ) {
      throw new BadRequestException("Invalid multipart part count");
    }

    this.multipartUploads ??= new Map();
    this.multipartInitializations ??= new Map();
    const multipartSessionKey = this.getMultipartSessionKey(
      "upload",
      shareId,
      file.id,
    );
    const flowId = this.getUploadFlowId(shareId, file.id);
    const existing = this.multipartUploads.get(multipartSessionKey);
    if (existing) {
      if (
        existing.totalParts !== undefined &&
        existing.totalParts !== totalParts
      ) {
        throw new BadRequestException("Multipart part count changed");
      }
      existing.totalParts ??= totalParts;
      existing.flowId ??= flowId;
      existing.lastActivity = Date.now();
      this.getAdaptiveUploadScheduler().registerFlow(flowId);
      return {
        id: file.id,
        initialized: false,
        initMs: 0,
        uploadedParts: await this.refreshMultipartParts(
          file.id,
          shareId,
          existing,
          totalParts,
        ),
      };
    }

    const inFlight = this.multipartInitializations.get(multipartSessionKey);
    if (inFlight) {
      const result = await inFlight;
      return { id: file.id, ...result };
    }

    const initialization = this.withMultipartLock(
      shareId,
      file.id,
      async () => {
        const startedAt = Date.now();
        const afterLock = this.multipartUploads.get(multipartSessionKey);
        if (afterLock) {
          if (
            afterLock.totalParts !== undefined &&
            afterLock.totalParts !== totalParts
          ) {
            throw new BadRequestException("Multipart part count changed");
          }
          afterLock.totalParts ??= totalParts;
          afterLock.flowId ??= flowId;
          afterLock.lastActivity = Date.now();
          this.getAdaptiveUploadScheduler().registerFlow(flowId);
          return {
            initialized: false,
            initMs: Date.now() - startedAt,
            uploadedParts: await this.refreshMultipartParts(
              file.id!,
              shareId,
              afterLock,
              totalParts,
            ),
          };
        }
        if (await this.recoverMultipartUpload(file.id!, shareId, totalParts)) {
          const recovered = this.multipartUploads.get(multipartSessionKey);
          return {
            initialized: false,
            initMs: Date.now() - startedAt,
            uploadedParts: this.getUploadedMultipartParts(
              recovered.parts,
              totalParts,
            ),
          };
        }
        const response = await this.getS3Instance().send(
          new CreateMultipartUploadCommand({
            Bucket: this.config.get("s3.bucketName"),
            Key: this.getShareObjectKey(shareId, file.id!),
          }),
        );
        if (!response.UploadId) {
          throw new Error("Failed to initialize multipart upload.");
        }
        this.multipartUploads.set(multipartSessionKey, {
          uploadId: response.UploadId,
          parts: [],
          lastActivity: Date.now(),
          shareId,
          flowId,
          totalParts,
        });
        this.getAdaptiveUploadScheduler().registerFlow(flowId);
        return {
          initialized: true,
          initMs: Date.now() - startedAt,
          uploadedParts: [],
        };
      },
    );
    this.multipartInitializations.set(multipartSessionKey, initialization);
    try {
      const result = await initialization;
      this.logger.log(
        `Multipart initialized: fileId=${file.id} totalParts=${totalParts} initMs=${result.initMs}`,
      );
      return { id: file.id, ...result };
    } finally {
      this.multipartInitializations.delete(multipartSessionKey);
    }
  }

  private getBrowserDirectPresignClient(
    definition: BrowserDirectSignerDefinition,
  ): S3Client {
    const region = (this.config.get("s3.region") ?? "").trim() || "us-east-1";
    const accessKeyId = this.config.get("s3.key");
    const secretAccessKey = this.config.get("s3.secret");
    const definitions = this.getBrowserDirectSignerDefinitions();
    const cacheKey = JSON.stringify([
      region,
      accessKeyId,
      secretAccessKey,
      definitions,
    ]);
    this.s3PresignClients ??= new Map<string, S3Client>();
    if (this.s3PresignClientCacheKey !== cacheKey) {
      for (const client of this.s3PresignClients.values()) client.destroy();
      this.s3PresignClients.clear();
      this.s3PresignClientCacheKey = cacheKey;
    }

    const clientKey = JSON.stringify([
      definition.endpoint,
      definition.addressingMode,
    ]);
    const existing = this.s3PresignClients.get(clientKey);
    if (existing) return existing;

    const client = new S3Client({
      endpoint: definition.endpoint,
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      forcePathStyle: definition.addressingMode === "path",
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      expectContinueHeader: false,
    });
    this.s3PresignClients.set(clientKey, client);
    return client;
  }

  private rotateBrowserDirectCandidates(
    candidates: BrowserDirectTransferCandidate[],
    fileId: string,
    sequence: number,
  ): BrowserDirectTransferCandidate[] {
    if (candidates.length < 2) return candidates;
    const fileHash = crypto
      .createHash("sha256")
      .update(fileId)
      .digest()
      .readUInt32BE(0);
    const start = (fileHash + Math.max(0, sequence - 1)) % candidates.length;
    return candidates.slice(start).concat(candidates.slice(0, start));
  }

  private async createBrowserDirectCandidates(
    fileId: string,
    sequence: number,
    expiresInSeconds: number,
    commandFactory: () => UploadPartCommand | GetObjectCommand,
  ): Promise<BrowserDirectTransferCandidate[]> {
    const signed = await Promise.all(
      this.getBrowserDirectSignerDefinitions().map(async (definition) => {
        const client = this.getBrowserDirectPresignClient(definition);
        const command = commandFactory();
        const url =
          command instanceof UploadPartCommand
            ? await getSignedUrl(client, command, {
                expiresIn: expiresInSeconds,
              })
            : await getSignedUrl(client, command, {
                expiresIn: expiresInSeconds,
              });
        const origin = new URL(url).origin;
        if (origin !== definition.expectedOrigin) {
          throw new InternalServerErrorException(
            `S3 signer origin mismatch for ${definition.addressingMode} addressing`,
          );
        }
        return {
          url,
          origin,
          addressingMode: definition.addressingMode,
        } satisfies BrowserDirectTransferCandidate;
      }),
    );
    const seenOrigins = new Set<string>();
    const unique = signed.filter((candidate) => {
      if (seenOrigins.has(candidate.origin)) return false;
      seenOrigins.add(candidate.origin);
      return true;
    });
    if (unique.length === 0) {
      throw new InternalServerErrorException(
        "No direct-browser S3 signer is available",
      );
    }
    return this.rotateBrowserDirectCandidates(unique, fileId, sequence);
  }

  /**
   * Authorize already-initialized multipart parts for direct browser PUTs.
   *
   * Content-Length is included in SigV4's signed headers. A caller therefore
   * cannot reuse the URL for a larger payload, while retrying the same part
   * number remains idempotent because S3 atomically replaces that part.
   */
  async createMultipartPartUploadUrls(
    fileId: string,
    shareId: string,
    totalParts: number,
    parts: Array<{ partIndex: number; contentLength: number }>,
  ): Promise<
    Array<{
      url: string;
      candidates: BrowserDirectTransferCandidate[];
      partNumber: number;
      contentLength: number;
      expiresInSeconds: number;
    }>
  > {
    const policy = this.getBrowserDirectUploadPolicy();
    if (!policy.enabled) {
      throw new HttpException(
        "Direct browser upload is unavailable",
        HttpStatus.NOT_FOUND,
      );
    }
    if (!isValidUUID(fileId)) {
      throw new BadRequestException("Invalid file ID format");
    }
    if (
      !Number.isSafeInteger(totalParts) ||
      totalParts < 2 ||
      totalParts > 10_000 ||
      !Array.isArray(parts) ||
      parts.length < 1 ||
      parts.length > MAX_BROWSER_DIRECT_PART_URLS
    ) {
      throw new BadRequestException("Invalid multipart part authorization");
    }
    const seenPartIndexes = new Set<number>();
    for (const { partIndex, contentLength } of parts) {
      if (
        !Number.isSafeInteger(partIndex) ||
        partIndex < 0 ||
        partIndex >= totalParts ||
        seenPartIndexes.has(partIndex) ||
        !Number.isSafeInteger(contentLength) ||
        contentLength <= 0
      ) {
        throw new BadRequestException("Invalid multipart part authorization");
      }
      if (
        partIndex < totalParts - 1 &&
        contentLength < S3_MIN_MULTIPART_PART_BYTES
      ) {
        throw new BadRequestException(
          `S3 multipart chunk must be at least ${S3_MIN_MULTIPART_PART_BYTES} bytes`,
        );
      }
      seenPartIndexes.add(partIndex);
    }

    this.multipartUploads ??= new Map();
    const multipartSessionKey = this.getMultipartSessionKey(
      "upload",
      shareId,
      fileId,
    );
    let multipartUpload = this.multipartUploads.get(multipartSessionKey);
    if (
      !multipartUpload &&
      (await this.recoverMultipartUpload(fileId, shareId, totalParts))
    ) {
      multipartUpload = this.multipartUploads.get(multipartSessionKey);
    }
    if (!multipartUpload) {
      throw new HttpException(
        "Multipart upload session not found",
        HttpStatus.CONFLICT,
      );
    }
    if (
      multipartUpload.totalParts !== undefined &&
      multipartUpload.totalParts !== totalParts
    ) {
      throw new BadRequestException("Multipart part count changed");
    }

    multipartUpload.totalParts ??= totalParts;
    multipartUpload.lastActivity = Date.now();
    const flowId = this.getUploadFlowId(shareId, fileId);
    multipartUpload.flowId ??= flowId;
    this.getAdaptiveUploadScheduler().touchFlow(flowId);

    const authorizations = await Promise.all(
      parts.map(async ({ partIndex, contentLength }) => {
        const partNumber = partIndex + 1;
        const candidates = await this.createBrowserDirectCandidates(
          fileId,
          partNumber,
          policy.expiresInSeconds,
          () =>
            new UploadPartCommand({
              Bucket: this.config.get("s3.bucketName"),
              Key: this.getShareObjectKey(shareId, fileId),
              UploadId: multipartUpload.uploadId,
              PartNumber: partNumber,
              ContentLength: contentLength,
            }),
        );
        return {
          url: candidates[0].url,
          candidates,
          partNumber,
          contentLength,
          expiresInSeconds: policy.expiresInSeconds,
        };
      }),
    );
    this.logger.debug(
      `Direct UploadPart batch authorized: dataPlane=${S3_DATA_PLANE_REVISION} ` +
        `fileId=${fileId} parts=${authorizations.length} origins=${policy.originCount} ` +
        `ttlSeconds=${policy.expiresInSeconds}`,
    );
    return authorizations;
  }

  async createMultipartPartUploadUrl(
    fileId: string,
    shareId: string,
    totalParts: number,
    partIndex: number,
    contentLength: number,
  ): Promise<{
    url: string;
    candidates: BrowserDirectTransferCandidate[];
    partNumber: number;
    contentLength: number;
    expiresInSeconds: number;
  }> {
    const [authorization] = await this.createMultipartPartUploadUrls(
      fileId,
      shareId,
      totalParts,
      [{ partIndex, contentLength }],
    );
    return authorization;
  }

  async createBrowserDownloadUrl(
    shareId: string,
    fileId: string,
    fileName: string,
    forceDownload: boolean,
    contentType: string,
  ): Promise<{
    url: string;
    candidates: BrowserDirectTransferCandidate[];
    expiresInSeconds: number;
  }> {
    const policy = this.getBrowserDirectDownloadPolicy();
    if (!policy.enabled) {
      throw new HttpException(
        "Direct browser download is unavailable",
        HttpStatus.NOT_FOUND,
      );
    }
    if (!isValidUUID(fileId)) {
      throw new BadRequestException("Invalid file ID format");
    }

    const candidates = await this.createBrowserDirectCandidates(
      fileId,
      1,
      policy.expiresInSeconds,
      () =>
        new GetObjectCommand({
          Bucket: this.config.get("s3.bucketName"),
          Key: this.getShareObjectKey(shareId, fileId),
          ResponseContentDisposition: contentDisposition(fileName, {
            type: forceDownload ? "attachment" : "inline",
          }),
          ResponseContentType: contentType,
          ResponseCacheControl:
            "private, no-cache, no-store, must-revalidate, no-transform",
        }),
    );
    this.logger.debug(
      `Direct GetObject authorized: dataPlane=${S3_DATA_PLANE_REVISION} ` +
        `fileId=${fileId} ttlSeconds=${policy.expiresInSeconds}`,
    );
    return {
      url: candidates[0].url,
      candidates,
      expiresInSeconds: policy.expiresInSeconds,
    };
  }

  async completeMultipartUpload(
    file: { id: string; name: string; relativePath?: string },
    shareId: string,
    totalParts: number,
    share: { isE2EEncrypted?: boolean },
    effectiveLimit: number,
    encryptionChunkSize?: number,
  ) {
    if (!isValidUUID(file.id)) {
      throw new BadRequestException("Invalid file ID format");
    }
    if (
      !Number.isSafeInteger(totalParts) ||
      totalParts < 2 ||
      totalParts > 10_000
    ) {
      throw new BadRequestException("Invalid multipart part count");
    }

    const key = this.getShareObjectKey(shareId, file.id);
    const bucketName = this.config.get("s3.bucketName");
    const multipartSessionKey = this.getMultipartSessionKey(
      "upload",
      shareId,
      file.id,
    );
    const flowId = this.getUploadFlowId(shareId, file.id);
    let sizeLimitExceeded = false;

    try {
      const result = await this.withMultipartLock(
        shareId,
        file.id,
        async (tx) => {
          const existing = await tx.file.findUnique({
            where: { id: file.id },
            select: { shareId: true },
          });
          if (existing) {
            if (existing.shareId !== shareId) {
              throw new BadRequestException("File ID is already in use");
            }
            this.multipartUploads.delete(multipartSessionKey);
            this.getAdaptiveUploadScheduler().unregisterFlow(flowId);
            return {
              ...file,
              uploadComplete: true,
              alreadyCompleted: true,
            };
          }

          let multipartUpload = this.multipartUploads.get(multipartSessionKey);
          if (
            !multipartUpload &&
            (await this.recoverMultipartUpload(file.id, shareId, totalParts))
          ) {
            multipartUpload = this.multipartUploads.get(multipartSessionKey);
          }

          let objectCompleted = false;
          if (multipartUpload) {
            let parts: ListedMultipartPart[] | undefined;
            try {
              parts = await this.listMultipartParts(
                key,
                multipartUpload.uploadId,
              );
            } catch (error) {
              if (!this.isS3UploadGone(error)) throw error;
            }

            if (parts) {
              parts.sort((left, right) => left.PartNumber - right.PartNumber);
              const validParts =
                parts.length === totalParts &&
                parts.every(
                  (part, index) => part.PartNumber === index + 1 && !!part.ETag,
                );
              if (!validParts) {
                throw new HttpException(
                  `Multipart upload is incomplete (${parts.length}/${totalParts} parts)`,
                  HttpStatus.CONFLICT,
                );
              }

              try {
                await this.getS3Instance().send(
                  new CompleteMultipartUploadCommand({
                    Bucket: bucketName,
                    Key: key,
                    UploadId: multipartUpload.uploadId,
                    MultipartUpload: {
                      Parts: parts.map(({ ETag, PartNumber }) => ({
                        ETag,
                        PartNumber,
                      })),
                    },
                  }),
                );
                objectCompleted = true;
              } catch (error) {
                // A lost Complete response leaves an uncertain S3 state. Head
                // is the idempotency oracle: if the object exists, continue;
                // otherwise preserve the multipart session for a safe retry.
                try {
                  await this.getS3Instance().send(
                    new HeadObjectCommand({ Bucket: bucketName, Key: key }),
                  );
                  objectCompleted = true;
                } catch {
                  throw error;
                }
              }
            }
          }

          let head;
          try {
            head = await this.getS3Instance().send(
              new HeadObjectCommand({ Bucket: bucketName, Key: key }),
            );
            objectCompleted = true;
          } catch (error) {
            if (!multipartUpload || !objectCompleted) {
              throw new InternalServerErrorException(
                "Multipart upload session not found.",
              );
            }
            throw error;
          }
          if (!objectCompleted) {
            throw new InternalServerErrorException(
              "Multipart upload completion failed.",
            );
          }

          const fileSize = head.ContentLength;
          if (!Number.isSafeInteger(fileSize) || (fileSize as number) < 0) {
            throw new InternalServerErrorException(
              "Invalid completed object size",
            );
          }

          const freshShare = await tx.share.findUnique({
            where: { id: shareId },
            select: { files: { select: { size: true } } },
          });
          if (!freshShare) throw new NotFoundException("Share not found");
          const currentSize = freshShare.files.reduce(
            (total, current) => total + parseInt(current.size),
            0,
          );
          if (currentSize + (fileSize as number) > effectiveLimit) {
            sizeLimitExceeded = true;
            throw new HttpException(
              "Max share size exceeded",
              HttpStatus.PAYLOAD_TOO_LARGE,
            );
          }

          await tx.file.create({
            data: {
              id: file.id,
              name: file.name,
              relativePath: file.relativePath,
              size: String(fileSize),
              encryptionChunkSize: share.isE2EEncrypted
                ? encryptionChunkSize
                : null,
              share: { connect: { id: shareId } },
            },
          });
          this.multipartUploads.delete(multipartSessionKey);
          this.getAdaptiveUploadScheduler().unregisterFlow(flowId);
          this.logger.log(
            `Multipart completed from S3 state: shareId=${shareId} fileId=${file.id} ` +
              `parts=${totalParts} sizeMiB=${Math.round((fileSize as number) / 1024 / 1024)}`,
          );
          return { ...file, uploadComplete: true };
        },
      );
      return result;
    } catch (error) {
      if (sizeLimitExceeded) {
        await this.getS3Instance()
          .send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }))
          .catch((cleanupError) => {
            this.logger.error(
              `Could not clean size-rejected S3 object: shareId=${shareId} fileId=${file.id}`,
              cleanupError instanceof Error ? cleanupError.stack : cleanupError,
            );
          });
      }
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `Multipart finalization failed: shareId=${shareId} fileId=${file.id}`,
        error instanceof Error ? error.stack : error,
      );
      throw new HttpException(
        "S3 upload temporarily unavailable",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  async create(
    data: Buffer | Readable,
    chunk: { index: number; total: number },
    file: { id?: string; name: string; relativePath?: string },
    shareId: string,
    _clientChunkSize?: number,
    _share?: any,
    effectiveLimit?: number,
    contentLength?: number,
    encryptionChunkSize?: number,
  ) {
    const originalFileId = file.id;
    if (!file.id) {
      file.id = crypto.randomUUID();
      this.logger.debug(
        `Upload started: shareId=${shareId} fileId=${file.id} fileName="${file.name}" note="generated fileId"`,
      );
    } else if (!isValidUUID(file.id)) {
      this.logger.warn(
        `Invalid fileId format on upload: shareId=${shareId} fileId="${originalFileId}"`,
      );
      throw new BadRequestException("Invalid file ID format");
    }
    const uploadLength =
      contentLength ?? (Buffer.isBuffer(data) ? data.length : 0);
    if (!Number.isSafeInteger(uploadLength) || uploadLength < 0) {
      throw new BadRequestException("Invalid upload content length");
    }
    if (
      chunk.index < chunk.total - 1 &&
      uploadLength < S3_MIN_MULTIPART_PART_BYTES
    ) {
      throw new BadRequestException(
        `S3 multipart chunk must be at least ${S3_MIN_MULTIPART_PART_BYTES} bytes`,
      );
    }
    // Use fileId as the S3 object key -- never the user-supplied filename.
    // This prevents overwrites when two files share the same name and
    // eliminates path-traversal risks from crafted filenames.
    const key = this.getShareObjectKey(shareId, file.id);
    const slotKey = this.getUploadFlowId(shareId, file.id);
    const multipartSessionKey = this.getMultipartSessionKey(
      "upload",
      shareId,
      file.id,
    );
    const bucketName = this.config.get("s3.bucketName");
    const s3Instance = this.getS3Instance();

    let allPartsComplete = false;
    let multipartInitMs: number | undefined;

    try {
      // Legacy clients still initialize with part 1. New clients use the
      // lightweight /multipart/init control request and reach this branch with
      // an existing session, allowing all data lanes to start together.
      if (
        chunk.index === 0 &&
        !this.multipartUploads.has(multipartSessionKey)
      ) {
        const initialization = await this.initializeMultipartUpload(
          file,
          shareId,
          chunk.total,
        );
        multipartInitMs = initialization.initMs;
      }

      // Get the ongoing multipart upload
      let multipartUpload = this.multipartUploads.get(multipartSessionKey);
      if (
        !multipartUpload &&
        chunk.index > 0 &&
        (await this.recoverMultipartUpload(file.id, shareId, chunk.total))
      ) {
        multipartUpload = this.multipartUploads.get(multipartSessionKey);
      }
      if (!multipartUpload) {
        // Idempotency guard: a retried chunk can arrive *after* the upload
        // already completed successfully, when the Complete response was lost
        // in transit (e.g. a proxy/WAF response timeout on the long
        // CompleteMultipartUpload of many parts). In that case the bytes are
        // safely stored and the DB record already exists -- so return success
        // instead of a phantom 500 at 100% that leaves the share unfinalized.
        if (await this.isUploadAlreadyCompleted(file.id, shareId)) {
          this.logger.warn(
            `Idempotent completion (session absent): fileId=${file.id} ` +
              `shareId=${shareId} chunk=${chunk.index}/${chunk.total}`,
          );
          return file;
        }
        throw new InternalServerErrorException(
          "Multipart upload session not found.",
        );
      }
      if (
        multipartUpload.totalParts !== undefined &&
        multipartUpload.totalParts !== chunk.total
      ) {
        throw new BadRequestException("Multipart part count changed");
      }
      multipartUpload.totalParts ??= chunk.total;
      multipartUpload.flowId ??= slotKey;
      this.getAdaptiveUploadScheduler().touchFlow(slotKey);

      // Refresh activity timestamp so the cleanup job never kills
      // a long-running but actively-uploading session.
      multipartUpload.lastActivity = Date.now();

      const uploadId = multipartUpload.uploadId;

      // Upload the current chunk (bounded by global + per-file concurrency).
      // Streaming requests are forwarded while bytes arrive, avoiding the
      // former receive-entire-body then send-entire-body relay.
      const partNumber = chunk.index + 1; // Part numbers start from 1

      const slotWaitStart = Date.now();
      const acquired = await this.acquireUploadSlot(slotKey);
      const slotWaitMs = Date.now() - slotWaitStart;
      if (!acquired) {
        throw new HttpException(
          "Server busy, retry later",
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      let uploadPartResponse: UploadPartCommandOutput;
      const uploadPartStart = Date.now();
      const requestStartedAt = Buffer.isBuffer(data)
        ? undefined
        : getUploadRequestStartedAt(data);
      const requestToS3Ms =
        requestStartedAt === undefined
          ? "untracked"
          : String(Math.max(0, uploadPartStart - requestStartedAt));
      let ingressEndedAt =
        Buffer.isBuffer(data) || data.readableEnded
          ? uploadPartStart
          : undefined;
      const recordIngressEnd = () => {
        ingressEndedAt ??= Date.now();
      };
      if (!Buffer.isBuffer(data) && ingressEndedAt === undefined) {
        // An `end` listener does not switch a Readable into flowing mode and
        // therefore cannot consume, copy or otherwise disturb upload bytes.
        data.once("end", recordIngressEnd);
      }
      try {
        uploadPartResponse = await s3Instance.send(
          new UploadPartCommand({
            Bucket: bucketName,
            Key: key,
            PartNumber: partNumber,
            UploadId: uploadId,
            Body: data,
            ContentLength: uploadLength,
          }),
        );
        const uploadPartDoneAt = Date.now();
        const uploadPartMs = uploadPartDoneAt - uploadPartStart;
        const ingressEndMs =
          ingressEndedAt === undefined
            ? "pending"
            : String(Math.max(0, ingressEndedAt - uploadPartStart));
        const s3TailMs =
          ingressEndedAt === undefined
            ? "pending"
            : String(Math.max(0, uploadPartDoneAt - ingressEndedAt));
        const mibPerSecond = uploadLength
          ? Number(
              (uploadLength / 1024 / 1024 / (uploadPartMs / 1000)).toFixed(1),
            )
          : 0;
        const attempts = uploadPartResponse.$metadata?.attempts ?? 1;
        const retryDelayMs = uploadPartResponse.$metadata?.totalRetryDelay ?? 0;
        const multipartInitMetric =
          multipartInitMs === undefined
            ? ""
            : ` multipartInitMs=${multipartInitMs}`;
        const scheduler = this.getAdaptiveUploadScheduler().getSnapshot();
        this.logger.log(
          `UploadPart done: dataPlane=${S3_DATA_PLANE_REVISION} wire=${this.s3TransportDiagnostics?.uploadWireFormat ?? "content-length"} fileId=${file.id} part=${partNumber} sizeMiB=${Math.round(uploadLength / 1024 / 1024)} durationMs=${uploadPartMs} throughputMiBps=${mibPerSecond} activeSlots=${scheduler.activeSlots} targetSlots=${scheduler.targetSlots} activeFlows=${scheduler.activeFlows} fairShare=${scheduler.fairShare} queuedSlots=${scheduler.queuedRequests} memoryPressure=${scheduler.memoryPressure.toFixed(3)} cpuPressure=${scheduler.cpuPressure.toFixed(3)} eventLoopLagMs=${Math.round(scheduler.eventLoopLagMs)} pressureSamples=${scheduler.pressureSamples} requestToS3Ms=${requestToS3Ms} slotWaitMs=${slotWaitMs}${multipartInitMetric} ingressEndMs=${ingressEndMs} s3TailMs=${s3TailMs} attempts=${attempts} retryDelayMs=${retryDelayMs} ${this.getS3TransportPoolMetrics()}`,
        );
      } finally {
        if (!Buffer.isBuffer(data)) {
          data.removeListener("end", recordIngressEnd);
        }
        this.releaseUploadSlot(slotKey);
      }

      // Store the ETag and PartNumber for later completion.
      // Deduplicate: if a chunk was retried after a network failure that
      // occurred *after* the backend had already pushed the part (e.g.
      // Caddy 502 while writing the response back), the same PartNumber
      // would be recorded twice.  Without dedup, parts.length would reach
      // chunk.total prematurely with missing unique parts -> corrupted file.
      const existingIdx = multipartUpload.parts.findIndex(
        (p) => p.PartNumber === partNumber,
      );
      if (existingIdx >= 0) {
        multipartUpload.parts[existingIdx] = {
          ETag: uploadPartResponse.ETag,
          PartNumber: partNumber,
          Size: uploadLength,
        };
      } else {
        multipartUpload.parts.push({
          ETag: uploadPartResponse.ETag,
          PartNumber: partNumber,
          Size: uploadLength,
        });
      }

      // Complete the multipart upload when ALL unique parts have arrived.
      // With parallel chunk uploads, the last part to finish may not
      // have the highest index -- so check count, not index.
      // Has its own try-catch so Complete failures are handled separately
      // from UploadPart failures (see outer catch for the UploadPart logic).
      if (multipartUpload.parts.length === chunk.total) {
        multipartUpload.parts.sort((a, b) => a.PartNumber - b.PartNumber);
        try {
          await s3Instance.send(
            new CompleteMultipartUploadCommand({
              Bucket: bucketName,
              Key: key,
              UploadId: uploadId,
              MultipartUpload: {
                Parts: multipartUpload.parts,
              },
            }),
          );
          // Remove the completed upload from memory
          this.multipartUploads.delete(multipartSessionKey);
          this.getAdaptiveUploadScheduler().unregisterFlow(slotKey);
          allPartsComplete = true;
        } catch (completeError) {
          // Complete can succeed on S3 while its response is lost in the
          // WAF/proxy path. HeadObject is the idempotency oracle: if the final
          // object exists, materialize it normally. Otherwise keep the
          // multipart state for the explicit reconciliation endpoint; never
          // abort an uncertain upload and force all bytes to be resent.
          try {
            await s3Instance.send(
              new HeadObjectCommand({ Bucket: bucketName, Key: key }),
            );
            this.multipartUploads.delete(multipartSessionKey);
            this.getAdaptiveUploadScheduler().unregisterFlow(slotKey);
            allPartsComplete = true;
            this.logger.warn(
              `S3 complete response lost but object exists: fileId=${file.id} shareId=${shareId}`,
            );
          } catch {
            if (this.isS3UploadGone(completeError)) {
              this.multipartUploads.delete(multipartSessionKey);
              this.getAdaptiveUploadScheduler().unregisterFlow(slotKey);
            }
            this.logger.error(
              `S3 complete requires reconciliation: fileId=${file.id} chunk=${chunk.index}/${chunk.total}: ${(completeError as any)?.message}`,
              completeError instanceof Error
                ? completeError.stack
                : completeError,
            );
            throw new InternalServerErrorException(
              "Multipart upload completion failed.",
            );
          }
        }
      }
    } catch (error) {
      // HttpExceptions (429, 503, "session not found", "completion failed", etc.)
      // are already the correct final response - re-throw immediately.
      if (error instanceof HttpException) {
        throw error;
      }
      // If S3 explicitly tells us the upload session is gone (NoSuchUpload),
      // clean up in-memory state and return a non-recoverable error.
      // The client must restart the upload from chunk 0.
      if (this.isS3UploadGone(error)) {
        this.multipartUploads.delete(multipartSessionKey);
        this.getAdaptiveUploadScheduler().unregisterFlow(slotKey);
        // Same idempotency guard as above: the session may be gone on S3
        // precisely because the upload already completed. If the DB record
        // exists, treat the retried chunk as success instead of forcing a
        // full re-upload of an already-stored file.
        if (await this.isUploadAlreadyCompleted(file.id, shareId)) {
          this.logger.warn(
            `Idempotent completion (S3 session gone): fileId=${file.id} ` +
              `shareId=${shareId} chunk=${chunk.index}/${chunk.total}`,
          );
          return file;
        }
        this.logger.warn(
          `S3 multipart session gone: fileId=${file.id} chunk=${chunk.index}/${chunk.total}: ${(error as any)?.message}`,
        );
        throw new InternalServerErrorException(
          "Multipart upload session not found.",
        );
      }
      // Transient error (network timeout, MinIO briefly unavailable, etc.).
      // DO NOT abort the S3 session: the already-uploaded parts remain valid
      // and the in-memory tracking is still correct.  Return 503 so the
      // worker retries this specific chunk with exponential back-off.
      this.logger.error(
        `Transient S3 error: fileId=${file.id} chunk=${chunk.index}/${chunk.total}: ${(error as any)?.message}`,
        error instanceof Error ? error.stack : error,
      );
      throw new HttpException(
        "S3 upload temporarily unavailable, retry this chunk",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    if (allPartsComplete) {
      const fileSize: number = await this.getFileSize(shareId, file.id);

      // Re-read aggregate usage in the same SQLite transaction that records
      // the file so concurrent completions cannot silently exceed the limit.
      let sizeLimitExceeded = false;
      try {
        await this.prisma.$transaction(async (tx) => {
          if (effectiveLimit !== undefined) {
            const freshShare = await tx.share.findUnique({
              where: { id: shareId },
              select: { files: { select: { size: true } } },
            });
            const currentSize = (freshShare?.files ?? []).reduce(
              (n, { size }) => n + parseInt(size),
              0,
            );
            if (currentSize + fileSize > effectiveLimit) {
              sizeLimitExceeded = true;
              throw new HttpException(
                "Max share size exceeded",
                HttpStatus.PAYLOAD_TOO_LARGE,
              );
            }
          }
          await tx.file.create({
            data: {
              id: file.id,
              name: file.name,
              relativePath: file.relativePath,
              size: fileSize.toString(),
              encryptionChunkSize: _share?.isE2EEncrypted
                ? encryptionChunkSize
                : null,
              share: { connect: { id: shareId } },
            },
          });
        });
      } catch (error) {
        if (sizeLimitExceeded) {
          // Never hold a database transaction open during remote S3 I/O. The
          // object is not referenced because the transaction was rolled back.
          await this.getS3Instance()
            .send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }))
            .catch((cleanupError) => {
              this.logger.error(
                `Could not clean size-rejected S3 object: shareId=${shareId} fileId=${file.id}`,
                cleanupError instanceof Error
                  ? cleanupError.stack
                  : cleanupError,
              );
            });
        }
        throw error;
      }

      this.logger.debug(
        `File uploaded: shareId=${shareId} fileId=${file.id} fileName="${file.name}" size=${fileSize} mimeType=${mime.contentType(file.name.split(".").pop() ?? "") || false}`,
      );
    }

    return { ...file, uploadComplete: allPartsComplete };
  }

  /**
   * Replace the content of an existing file (re-encryption).
   * Same multipart upload flow as create() but overwrites the existing
   * S3 object and does NOT create a DB record.
   */
  async replace(
    data: Buffer,
    chunk: { index: number; total: number },
    fileId: string,
    shareId: string,
    encryptionChunkSize?: number,
  ) {
    if (!isValidUUID(fileId)) {
      throw new BadRequestException("Invalid file ID format");
    }

    const buffer = data;
    const key = this.getShareObjectKey(shareId, fileId);
    const bucketName = this.config.get("s3.bucketName");
    const s3Instance = this.getS3Instance();
    const slotKey = this.getUploadFlowId(shareId, fileId);
    const reencryptKey = this.getMultipartSessionKey(
      "reencrypt",
      shareId,
      fileId,
    );

    try {
      if (chunk.index === 0) {
        const staleUpload = this.multipartUploads.get(reencryptKey);
        if (staleUpload) {
          try {
            await s3Instance.send(
              new AbortMultipartUploadCommand({
                Bucket: bucketName,
                Key: key,
                UploadId: staleUpload.uploadId,
              }),
            );
          } catch (abortError) {
            this.logger.warn(
              `Could not abort stale re-encryption upload: shareId=${shareId} fileId=${fileId}: ${(abortError as Error)?.message}`,
            );
          }
          this.multipartUploads.delete(reencryptKey);
        }
        const multipartInitResponse = await s3Instance.send(
          new CreateMultipartUploadCommand({ Bucket: bucketName, Key: key }),
        );
        const uploadId = multipartInitResponse.UploadId;
        if (!uploadId)
          throw new Error("Failed to initialize multipart upload.");
        this.multipartUploads.set(reencryptKey, {
          uploadId,
          parts: [],
          lastActivity: Date.now(),
          shareId,
          flowId: slotKey,
          totalParts: chunk.total,
        });
        this.getAdaptiveUploadScheduler().registerFlow(slotKey);
      }

      const multipartUpload = this.multipartUploads.get(reencryptKey);
      if (!multipartUpload) {
        throw new InternalServerErrorException(
          "Multipart upload session not found.",
        );
      }

      multipartUpload.lastActivity = Date.now();

      const partNumber = chunk.index + 1;
      const acquired = await this.acquireUploadSlot(slotKey);
      if (!acquired) {
        throw new HttpException(
          "Server busy, retry later",
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      let uploadPartResponse: UploadPartCommandOutput;
      try {
        uploadPartResponse = await s3Instance.send(
          new UploadPartCommand({
            Bucket: bucketName,
            Key: key,
            PartNumber: partNumber,
            UploadId: multipartUpload.uploadId,
            Body: buffer,
          }),
        );
      } finally {
        this.releaseUploadSlot(slotKey);
      }

      // Deduplicate: if a chunk was retried after a network failure that
      // occurred *after* the backend had already pushed the part (e.g.
      // Caddy 502 while writing the response back), the same PartNumber
      // would be recorded twice.  Without dedup, CompleteMultipartUpload
      // receives duplicate parts and fails.
      const existingIdx = multipartUpload.parts.findIndex(
        (p) => p.PartNumber === partNumber,
      );
      if (existingIdx >= 0) {
        multipartUpload.parts[existingIdx] = {
          ETag: uploadPartResponse.ETag,
          PartNumber: partNumber,
          Size: buffer.length,
        };
      } else {
        multipartUpload.parts.push({
          ETag: uploadPartResponse.ETag,
          PartNumber: partNumber,
          Size: buffer.length,
        });
      }

      // SECURITY: Only finalize when ALL chunks have been received, not just the last index.
      // Chunks may arrive out-of-order; using index === total-1 would finalize prematurely.
      if (multipartUpload.parts.length === chunk.total) {
        // S3 requires parts to be sorted by PartNumber
        const sortedParts = [...multipartUpload.parts].sort(
          (a, b) => a.PartNumber - b.PartNumber,
        );
        await s3Instance.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucketName,
            Key: key,
            UploadId: multipartUpload.uploadId,
            MultipartUpload: { Parts: sortedParts },
          }),
        );
        this.multipartUploads.delete(reencryptKey);
        this.getAdaptiveUploadScheduler().unregisterFlow(slotKey);

        const fileSize = await this.getFileSize(shareId, fileId);
        const updated = await this.prisma.file.updateMany({
          where: { id: fileId, shareId },
          data: {
            size: fileSize.toString(),
            encryptionChunkSize: encryptionChunkSize ?? null,
          },
        });
        if (updated.count !== 1) {
          throw new NotFoundException("File not found in this share");
        }
        this.logger.debug(
          `File re-encrypted: shareId=${shareId} fileId=${fileId} size=${fileSize}`,
        );
      }
    } catch (error) {
      // Preserve uploaded parts so the client can retry the same PartNumber.
      // Chunk zero explicitly aborts/replaces a stale multipart session when a
      // full-file restart is required; the periodic cleanup handles abandoned
      // sessions.
      if (error instanceof HttpException) throw error;
      if (this.isS3UploadGone(error)) {
        this.multipartUploads.delete(reencryptKey);
        this.getAdaptiveUploadScheduler().unregisterFlow(slotKey);
        this.logger.warn(
          `S3 re-encryption session gone: shareId=${shareId} fileId=${fileId} chunk=${chunk.index}/${chunk.total}`,
        );
        throw new InternalServerErrorException(
          "Multipart upload session not found.",
        );
      }
      this.logger.error(
        `Transient S3 re-encryption error (multipart retained): shareId=${shareId} fileId=${fileId} chunk=${chunk.index}/${chunk.total}`,
        error instanceof Error ? error.stack : error,
      );
      throw new HttpException(
        "S3 re-encryption temporarily unavailable, retry this chunk",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private createDownloadAbortError(): Error {
    const error = new Error("Download aborted");
    error.name = "AbortError";
    return error;
  }

  private async openDownloadRange(
    flowId: string,
    key: string,
    start: number,
    end: number,
    controller: AbortController,
  ): Promise<OpenDownloadRange> {
    const scheduler = this.getAdaptiveDownloadScheduler();
    const acquired = await scheduler.acquire(
      flowId,
      undefined,
      controller.signal,
    );
    if (!acquired) {
      if (controller.signal.aborted) throw this.createDownloadAbortError();
      throw new HttpException(
        "Server download capacity is temporarily busy",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      scheduler.release(flowId);
    };

    try {
      const hasRange = end >= start;
      const expectedBytes = hasRange ? end - start + 1 : 0;
      const response = await this.getS3Instance().send(
        new GetObjectCommand({
          Bucket: this.config.get("s3.bucketName"),
          Key: key,
          ...(hasRange ? { Range: `bytes=${start}-${end}` } : {}),
        }),
        { abortSignal: controller.signal },
      );
      if (
        response.ContentLength !== undefined &&
        response.ContentLength !== expectedBytes
      ) {
        throw new Error(
          `S3 range length mismatch: expected=${expectedBytes} actual=${response.ContentLength}`,
        );
      }
      if (!(response.Body instanceof Readable)) {
        throw new Error("S3 download response is not a Node stream");
      }
      return { response, body: response.Body, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  private async readDownloadRangeWithRetry(
    flowId: string,
    key: string,
    start: number,
    end: number,
    controllers: Set<AbortController>,
    isAborted: () => boolean,
  ): Promise<Buffer> {
    const maxAttempts = getBoundedEnvironmentInteger(
      "S3_DOWNLOAD_RANGE_ATTEMPTS",
      3,
      1,
      8,
    );
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (isAborted()) throw this.createDownloadAbortError();
      const controller = new AbortController();
      controllers.add(controller);
      let opened: OpenDownloadRange | undefined;
      try {
        opened = await this.openDownloadRange(
          flowId,
          key,
          start,
          end,
          controller,
        );
        const chunks: Buffer[] = [];
        let received = 0;
        for await (const chunk of opened.body) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          chunks.push(buffer);
          received += buffer.length;
        }
        const expected = end - start + 1;
        if (received !== expected) {
          throw new Error(
            `Incomplete S3 range: expected=${expected} received=${received}`,
          );
        }
        return Buffer.concat(chunks, received);
      } catch (error) {
        lastError = error;
        controller.abort();
        if (
          isAborted() ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          throw this.createDownloadAbortError();
        }
        if (attempt < maxAttempts) {
          const delayMs =
            Math.min(250 * Math.pow(2, attempt - 1), 2_000) +
            Math.floor(Math.random() * 150);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      } finally {
        opened?.release();
        controllers.delete(controller);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("S3 range download failed");
  }

  private async createParallelDownloadStream(
    shareId: string,
    fileId: string,
    key: string,
    fileSize: number,
    flowId: string,
    concurrency: number,
    partBytes: number,
    maxBufferBytes: number,
  ): Promise<{
    stream: Readable;
    lastModified?: Date;
    responseHeadersMs: number;
  }> {
    const totalParts = Math.ceil(fileSize / partBytes);
    const maxBufferedParts = Math.max(
      1,
      Math.floor(maxBufferBytes / partBytes),
    );
    const configuredPrefetch = getBoundedEnvironmentInteger(
      "S3_DOWNLOAD_PREFETCH_PARTS",
      concurrency * 2,
      concurrency,
      64,
    );
    const prefetchParts = Math.min(
      totalParts,
      configuredPrefetch,
      maxBufferedParts + 1,
    );
    const controllers = new Set<AbortController>();
    const buffered = new Map<number, Promise<BufferedDownloadOutcome>>();
    let aborted = false;
    const isAborted = () => aborted;
    const abortAll = () => {
      if (aborted) return;
      aborted = true;
      for (const controller of controllers) controller.abort();
    };
    const getBounds = (index: number) => {
      const start = index * partBytes;
      return { start, end: Math.min(fileSize - 1, start + partBytes - 1) };
    };
    const launchBuffered = (index: number) => {
      if (index >= totalParts || buffered.has(index)) return;
      const bounds = getBounds(index);
      const result: Promise<BufferedDownloadOutcome> =
        this.readDownloadRangeWithRetry(
          flowId,
          key,
          bounds.start,
          bounds.end,
          controllers,
          isAborted,
        ).then(
          (buffer): BufferedDownloadOutcome => ({ ok: true, buffer }),
          (error): BufferedDownloadOutcome => ({ ok: false, error }),
        );
      buffered.set(index, result);
    };

    const startedAt = Date.now();
    const firstController = new AbortController();
    controllers.add(firstController);
    const firstBounds = getBounds(0);
    const firstPromise = this.openDownloadRange(
      flowId,
      key,
      firstBounds.start,
      firstBounds.end,
      firstController,
    );
    for (let index = 1; index < prefetchParts; index++) {
      launchBuffered(index);
    }

    let first: OpenDownloadRange;
    try {
      first = await firstPromise;
    } catch (error) {
      abortAll();
      this.getAdaptiveDownloadScheduler().unregisterFlow(flowId);
      throw error;
    }
    const responseHeadersMs = Date.now() - startedAt;
    const finishParallelDownload = (
      completed: boolean,
      emittedBytes: number,
    ) => {
      this.getAdaptiveDownloadScheduler().unregisterFlow(flowId);
      const durationMs = Math.max(1, Date.now() - startedAt);
      const mibPerSecond = Number(
        (emittedBytes / 1024 / 1024 / (durationMs / 1000)).toFixed(1),
      );
      const scheduler = this.getAdaptiveDownloadScheduler().getSnapshot();
      const message =
        `Download stream ${completed ? "done" : "failed"}: fileId=${fileId} ` +
        `sizeMiB=${Math.round(emittedBytes / 1024 / 1024)} durationMs=${durationMs} ` +
        `throughputMiBps=${mibPerSecond} responseHeadersMs=${responseHeadersMs} ` +
        `range=full mode=parallel partMiB=${Math.round(partBytes / 1024 / 1024)} ` +
        `lanes=${concurrency} targetSlots=${scheduler.targetSlots} activeFlows=${scheduler.activeFlows} ` +
        `queuedSlots=${scheduler.queuedRequests} memoryPressure=${scheduler.memoryPressure.toFixed(3)} ` +
        `cpuPressure=${scheduler.cpuPressure.toFixed(3)} eventLoopLagMs=${Math.round(scheduler.eventLoopLagMs)} ` +
        `pressureSamples=${scheduler.pressureSamples} ` +
        this.getS3TransportPoolMetrics();
      if (completed) this.logger.log(message);
      else this.logger.warn(message);
    };
    const stream = Readable.from(
      (async function* () {
        let completed = false;
        let emittedBytes = 0;
        try {
          for await (const chunk of first.body) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            emittedBytes += buffer.length;
            yield buffer;
          }
          if (emittedBytes !== firstBounds.end - firstBounds.start + 1) {
            throw new Error(
              `Incomplete first S3 range: received=${emittedBytes}`,
            );
          }
          first.release();
          controllers.delete(firstController);

          for (let index = 1; index < totalParts; index++) {
            const outcome = await buffered.get(index);
            buffered.delete(index);
            if (!outcome) {
              throw new Error(`Missing prefetched S3 range ${index}`);
            }
            if (outcome.ok === false) throw outcome.error;

            // Refill before yielding so S3 keeps working while the previous
            // ordered buffer is drained to the browser. Buffer count stays
            // bounded by S3_DOWNLOAD_MAX_BUFFER_BYTES.
            launchBuffered(index + prefetchParts - 1);
            emittedBytes += outcome.buffer.length;
            yield outcome.buffer;
          }
          if (emittedBytes !== fileSize) {
            throw new Error(
              `Incomplete parallel download: expected=${fileSize} received=${emittedBytes}`,
            );
          }
          completed = true;
        } finally {
          first.release();
          controllers.delete(firstController);
          abortAll();
          finishParallelDownload(completed, emittedBytes);
        }
      })(),
      { objectMode: false },
    );

    return {
      stream,
      lastModified: first.response.LastModified,
      responseHeadersMs,
    };
  }

  private async createDirectDownloadStream(
    fileId: string,
    key: string,
    fileSize: number,
    flowId: string,
    range?: { start: number; end: number },
  ): Promise<{
    stream: Readable;
    lastModified?: Date;
    responseHeadersMs: number;
  }> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const start = range?.start ?? 0;
    const end = range?.end ?? fileSize - 1;
    let opened: OpenDownloadRange;
    try {
      opened = await this.openDownloadRange(
        flowId,
        key,
        start,
        end,
        controller,
      );
    } catch (error) {
      this.getAdaptiveDownloadScheduler().unregisterFlow(flowId);
      throw error;
    }
    const responseHeadersMs = Date.now() - startedAt;
    const bytes = Math.max(0, end - start + 1);
    let settled = false;
    const finish = (completed: boolean, error?: Error) => {
      if (settled) return;
      settled = true;
      opened.release();
      if (!completed) controller.abort();
      this.getAdaptiveDownloadScheduler().unregisterFlow(flowId);
      const durationMs = Math.max(1, Date.now() - startedAt);
      const mibPerSecond = Number(
        (bytes / 1024 / 1024 / (durationMs / 1000)).toFixed(1),
      );
      const scheduler = this.getAdaptiveDownloadScheduler().getSnapshot();
      if (completed) {
        this.logger.log(
          `Download stream done: fileId=${fileId} sizeMiB=${Math.round(bytes / 1024 / 1024)} ` +
            `durationMs=${durationMs} throughputMiBps=${mibPerSecond} ` +
            `responseHeadersMs=${responseHeadersMs} range=${range ? `${start}-${end}` : "full"} mode=direct ` +
            `targetSlots=${scheduler.targetSlots} activeFlows=${scheduler.activeFlows} ` +
            `queuedSlots=${scheduler.queuedRequests} memoryPressure=${scheduler.memoryPressure.toFixed(3)} ` +
            `cpuPressure=${scheduler.cpuPressure.toFixed(3)} eventLoopLagMs=${Math.round(scheduler.eventLoopLagMs)} ` +
            `pressureSamples=${scheduler.pressureSamples} ` +
            this.getS3TransportPoolMetrics(),
        );
      } else {
        this.logger.warn(
          `Download stream failed: fileId=${fileId} responseHeadersMs=${responseHeadersMs} ` +
            `error=${error?.message || "client closed stream"}`,
        );
      }
    };
    opened.body.once("end", () => finish(true));
    opened.body.once("error", (error) => finish(false, error));
    opened.body.once("close", () => finish(false));
    return {
      stream: opened.body,
      lastModified: opened.response.LastModified,
      responseHeadersMs,
    };
  }

  async get(
    shareId: string,
    fileId: string,
    range?: { start: number; end: number },
  ): Promise<File> {
    const fileRecord = await this.prisma.file.findFirst({
      where: { id: fileId, shareId },
    });
    if (!fileRecord) throw new NotFoundException("File not found");
    const fileSize = Number(fileRecord.size);
    if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
      throw new InternalServerErrorException("Invalid stored file size");
    }
    const fileName = fileRecord.name;
    const key = this.getShareObjectKey(shareId, fileId);
    const flowId = `${shareId}:${fileId}:download:${crypto.randomUUID()}`;
    const scheduler = this.getAdaptiveDownloadScheduler();
    const allocation = scheduler.getAllocation(flowId, {
      allowBorrowing: false,
    });
    const partBytes = getBoundedEnvironmentInteger(
      "S3_DOWNLOAD_PART_BYTES",
      DEFAULT_DOWNLOAD_PART_BYTES,
      5 * 1024 * 1024,
      128 * 1024 * 1024,
    );
    const thresholdBytes = Math.max(
      partBytes * 2,
      getBoundedEnvironmentInteger(
        "S3_PARALLEL_DOWNLOAD_THRESHOLD_BYTES",
        DEFAULT_PARALLEL_DOWNLOAD_THRESHOLD_BYTES,
        5 * 1024 * 1024,
        Number.MAX_SAFE_INTEGER,
      ),
    );
    const maxBufferBytes = getBoundedEnvironmentInteger(
      "S3_DOWNLOAD_MAX_BUFFER_BYTES",
      DEFAULT_DOWNLOAD_MAX_BUFFER_BYTES,
      partBytes,
      1024 * 1024 * 1024,
    );
    const parallelEnabled =
      (process.env.S3_PARALLEL_DOWNLOAD_ENABLED ?? "true")
        .trim()
        .toLowerCase() !== "false";
    const canParallelize =
      !range &&
      parallelEnabled &&
      fileSize >= thresholdBytes &&
      allocation.recommendedSlots >= 2;

    const download = canParallelize
      ? await this.createParallelDownloadStream(
          shareId,
          fileId,
          key,
          fileSize,
          flowId,
          allocation.recommendedSlots,
          partBytes,
          maxBufferBytes,
        )
      : await this.createDirectDownloadStream(
          fileId,
          key,
          fileSize,
          flowId,
          range,
        );
    const mimeType =
      mime.contentType(fileName.split(".").pop()) || "application/octet-stream";
    const size = range ? String(range.end - range.start + 1) : String(fileSize);
    this.logger.debug(
      `File download opened: shareId=${shareId} fileId=${fileId} fileName="${fileName}" ` +
        `size=${size} mimeType=${mimeType} mode=${canParallelize ? "parallel" : "direct"} ` +
        `responseHeadersMs=${download.responseHeadersMs}`,
    );

    return {
      metaData: {
        id: fileId,
        size,
        name: fileName,
        relativePath:
          (fileRecord as { relativePath?: string | null }).relativePath ?? null,
        encryptionChunkSize:
          (
            fileRecord as {
              encryptionChunkSize?: number | null;
            }
          ).encryptionChunkSize ?? null,
        shareId,
        createdAt:
          download.lastModified ||
          (fileRecord as { createdAt?: Date }).createdAt ||
          new Date(),
        mimeType,
      },
      file: download.stream,
    } as File;
  }

  async remove(shareId: string, fileId: string) {
    const fileMetaData = await this.prisma.file.findFirst({
      where: { id: fileId, shareId },
    });

    if (!fileMetaData) throw new NotFoundException("File not found");

    const key = this.getShareObjectKey(shareId, fileId);
    const s3Instance = this.getS3Instance();

    try {
      await s3Instance.send(
        new DeleteObjectCommand({
          Bucket: this.config.get("s3.bucketName"),
          Key: key,
        }),
      );
    } catch (error) {
      this.logger.error(error);
      throw new Error("Could not delete file from S3");
    }

    await this.prisma.file.delete({ where: { id: fileId } });
    this.logger.debug(
      `File deleted: shareId=${shareId} fileId=${fileMetaData.id} fileName="${fileMetaData.name}" size=${fileMetaData.size}`,
    );
  }

  async deleteAllFiles(shareId: string) {
    this.logger.debug(`Delete all files requested: shareId=${shareId}`);
    const prefix = this.getSharePrefix(shareId);
    const bucket = this.config.get("s3.bucketName");
    const s3Instance = this.getS3Instance();

    // First, abort any in-progress multipart uploads for this share
    await this.abortShareMultipartUploads(shareId);

    try {
      // Paginate through all objects under the prefix (handles >1000 files)
      let continuationToken: string | undefined;
      let totalDeleted = 0;

      do {
        const listResponse = await s3Instance.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );

        if (!listResponse.Contents || listResponse.Contents.length === 0) {
          if (totalDeleted === 0) {
            this.logger.warn(
              `No files found in S3 for share ${shareId} - skipping deletion`,
            );
          }
          break;
        }

        const objectsToDelete = listResponse.Contents.map((file) => ({
          Key: file.Key!,
        }));

        await s3Instance.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: objectsToDelete },
          }),
        );

        totalDeleted += objectsToDelete.length;
        continuationToken = listResponse.IsTruncated
          ? listResponse.NextContinuationToken
          : undefined;
      } while (continuationToken);

      if (totalDeleted > 0) {
        this.logger.log(
          `Deleted ${totalDeleted} S3 objects for share ${shareId}`,
        );
      }
    } catch (error) {
      this.logger.error(error);
      throw new Error("Could not delete all files from S3");
    }
  }

  async getFileSize(shareId: string, fileId: string): Promise<number> {
    const key = this.getShareObjectKey(shareId, fileId);
    const s3Instance = this.getS3Instance();

    try {
      // Get metadata of the file using HeadObjectCommand
      const headObjectResponse = await s3Instance.send(
        new HeadObjectCommand({
          Bucket: this.config.get("s3.bucketName"),
          Key: key,
        }),
      );

      // Return ContentLength which is the file size in bytes
      return headObjectResponse.ContentLength ?? 0;
    } catch {
      throw new Error("Could not retrieve file size");
    }
  }

  getS3Instance(): S3Client {
    // Since AWS SDK v3.729, WHEN_SUPPORTED adds a CRC32 trailer to every
    // streaming UploadPart. The SDK's JavaScript CRC implementation runs on
    // Node's single event-loop thread and can cap the aggregate data plane at
    // a few dozen MiB/s regardless of the number of S3 sockets. Required-only
    // remains protocol-correct: mandatory checksums are still calculated,
    // while TLS, SigV4 and (for E2E shares) AES-GCM protect normal transfers.
    //
    // Required-only is a data-plane invariant, not merely a Compose default.
    // This prevents an old mounted config or deployment .env from silently
    // restoring the single-threaded optional CRC after an image update.
    // Optional checksums require an explicit double opt-in and remain useful
    // only for a storage provider that mandates them.
    const optionalChecksumOptIn = (
      process.env.S3_ALLOW_OPTIONAL_CHECKSUMS ?? "false"
    )
      .trim()
      .toLowerCase();
    if (optionalChecksumOptIn !== "true" && optionalChecksumOptIn !== "false") {
      throw new Error("S3_ALLOW_OPTIONAL_CHECKSUMS must be true or false");
    }
    const allowOptionalChecksums = optionalChecksumOptIn === "true";
    const requestChecksumCalculation = allowOptionalChecksums
      ? getChecksumCalculation(
          "AWS_REQUEST_CHECKSUM_CALCULATION",
          "WHEN_REQUIRED",
        )
      : "WHEN_REQUIRED";
    const responseChecksumValidation = allowOptionalChecksums
      ? getChecksumCalculation(
          "AWS_RESPONSE_CHECKSUM_VALIDATION",
          "WHEN_REQUIRED",
        )
      : "WHEN_REQUIRED";
    const uploadWireFormat =
      requestChecksumCalculation === "WHEN_REQUIRED"
        ? "content-length"
        : "aws-chunked-opt-in";
    const endpoint = (this.config.get("s3.endpoint") ?? "").trim();
    const region = (this.config.get("s3.region") ?? "").trim() || "us-east-1";
    const accessKeyId = this.config.get("s3.key");
    const secretAccessKey = this.config.get("s3.secret");
    const explicitS3Proxy = (process.env.S3_PROXY_URL || "").trim();
    const sharedProxy = (
      process.env.GLOBAL_AGENT_HTTPS_PROXY ||
      process.env.GLOBAL_AGENT_HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY ||
      ""
    ).trim();
    const noProxy = [process.env.GLOBAL_AGENT_NO_PROXY, process.env.NO_PROXY]
      .filter(Boolean)
      .join(",");
    // NO_PROXY is authoritative, including when S3_PROXY_URL is configured.
    // Forcing a private S3/MinIO endpoint through a forward proxy can make
    // every operation fail (CONNECT is commonly limited to public :443).
    // Operators that need a proxy must remove the S3 host from NO_PROXY;
    // S3_PROXY_URL then selects the dedicated proxy without affecting other
    // outbound traffic.
    const noProxyMatched = endpointBypassesProxy(endpoint, noProxy);
    const proxyUrl = noProxyMatched ? "" : explicitS3Proxy || sharedProxy;
    const routePolicy = noProxyMatched
      ? "no-proxy"
      : explicitS3Proxy
        ? "s3-proxy"
        : sharedProxy
          ? "shared-proxy"
          : "direct";
    const configuredUploadSlots = Math.max(
      1,
      parseInt(process.env.S3_MAX_CONCURRENT_UPLOADS || "6", 10) || 6,
    );
    const configuredDownloadSlots = Math.max(
      1,
      parseInt(process.env.S3_MAX_CONCURRENT_DOWNLOADS || "6", 10) || 6,
    );
    const maxSockets = Math.max(
      configuredUploadSlots + configuredDownloadSlots,
      parseInt(process.env.S3_HTTP_MAX_SOCKETS || "50", 10) || 50,
    );
    const socketBufferBytes = Math.min(
      8 * 1024 * 1024,
      Math.max(
        64 * 1024,
        parseInt(process.env.S3_HTTP_SOCKET_BUFFER_BYTES || "1048576", 10) ||
          1024 * 1024,
      ),
    );
    const cacheKey = JSON.stringify([
      endpoint,
      region,
      accessKeyId,
      secretAccessKey,
      requestChecksumCalculation,
      responseChecksumValidation,
      allowOptionalChecksums,
      proxyUrl,
      noProxy,
      noProxyMatched,
      routePolicy,
      maxSockets,
      socketBufferBytes,
      configuredUploadSlots,
      configuredDownloadSlots,
    ]);

    // Reusing the SDK client also reuses its keep-alive connection pool.
    // Creating one per chunk forced repeated TCP/TLS setup on large files.
    if (this.s3Client && this.s3ClientCacheKey === cacheKey) {
      return this.s3Client;
    }
    this.s3Client?.destroy();
    this.s3TransportAgent = undefined;
    this.s3ProxyConnects = 0;
    this.s3ProxyConnectFailures = 0;

    // Keep the direct preproduction path on Smithy's native pooled transport,
    // which is also the path that previously reached the highest measured
    // throughput. An explicit external Agent changes request-body scheduling
    // inside NodeHttpHandler and is only necessary for production CONNECT.
    const isHttps = !endpoint || endpoint.startsWith("https");
    const agentOptions = {
      keepAlive: true,
      keepAliveMsecs: 1_000,
      maxSockets,
      maxFreeSockets: Math.min(maxSockets, 16),
      // A small default writable high-water mark causes excessive
      // backpressure/context switching on high-BDP TLS and CONNECT tunnels.
      // One MiB per live S3 socket remains bounded by maxSockets and can be
      // lowered from Compose on memory-constrained hosts.
      highWaterMark: socketBufferBytes,
    };
    let agent: HttpAgent | HttpsAgent | undefined;
    if (proxyUrl) {
      let parsedProxy: URL;
      try {
        parsedProxy = new URL(proxyUrl);
      } catch {
        throw new Error("Invalid S3 proxy URL");
      }
      if (!["http:", "https:"].includes(parsedProxy.protocol)) {
        throw new Error("Invalid S3 proxy protocol");
      }
      agent = new HttpsProxyAgent(parsedProxy, agentOptions);
      agent.on(
        "proxyConnect",
        (response: { statusCode?: number } | undefined) => {
          this.s3ProxyConnects++;
          if (response?.statusCode !== 200) {
            this.s3ProxyConnectFailures++;
          }
        },
      );
    }
    this.s3TransportAgent = agent;
    const endpointHost = (() => {
      if (!endpoint) return "aws-default";
      try {
        return new URL(endpoint).host;
      } catch {
        return "invalid";
      }
    })();
    const globalAgentForce = (
      process.env.GLOBAL_AGENT_FORCE_GLOBAL_AGENT ?? "unset"
    )
      .trim()
      .toLowerCase();
    const directUploadPolicy = this.getBrowserDirectUploadPolicy();
    const directDownloadPolicy = this.getBrowserDirectDownloadPolicy();
    this.s3TransportDiagnostics = {
      revision: S3_DATA_PLANE_REVISION,
      initialized: true,
      route: proxyUrl ? "proxy" : "direct",
      requestChecksum: requestChecksumCalculation,
      responseChecksum: responseChecksumValidation,
      uploadWireFormat,
      expectContinue: false,
      browserDirectUpload: directUploadPolicy.enabled,
      browserDirectUploadAddressingMode: directUploadPolicy.addressingMode,
      browserDirectUploadOriginCount: directUploadPolicy.originCount,
      browserDirectUploadConnectionsPerOrigin:
        directUploadPolicy.connectionsPerOrigin,
      browserDirectUploadMaxConcurrency: directUploadPolicy.maxConcurrency,
      browserDirectUploadExpiresInSeconds: directUploadPolicy.expiresInSeconds,
      browserDirectDownload: directDownloadPolicy.enabled,
      browserDirectDownloadMaxConcurrency: directDownloadPolicy.maxConcurrency,
      browserDirectDownloadPartBytes: directDownloadPolicy.partBytes,
      browserDirectDownloadThresholdBytes: directDownloadPolicy.thresholdBytes,
      browserDirectDownloadMaxBufferBytes: directDownloadPolicy.maxBufferBytes,
      browserDirectDownloadExpiresInSeconds:
        directDownloadPolicy.expiresInSeconds,
    };
    if (
      !allowOptionalChecksums &&
      (process.env.AWS_REQUEST_CHECKSUM_CALCULATION?.trim().toUpperCase() ===
        "WHEN_SUPPORTED" ||
        process.env.AWS_RESPONSE_CHECKSUM_VALIDATION?.trim().toUpperCase() ===
          "WHEN_SUPPORTED" ||
        this.config.get("s3.useChecksum") === true)
    ) {
      this.logger.warn(
        `Optional S3 checksums ignored by data-plane invariant: revision=${S3_DATA_PLANE_REVISION}. ` +
          "Set S3_ALLOW_OPTIONAL_CHECKSUMS=true only after a storage-specific benchmark.",
      );
    }
    const agentName = agent?.constructor.name ?? "SmithyDefault";
    const effectiveSocketBuffer = agent
      ? String(agentOptions.highWaterMark)
      : "sdk-default";
    this.logger.log(
      `S3 transport configured: dataPlane=${S3_DATA_PLANE_REVISION} wire=${uploadWireFormat} route=${proxyUrl ? "proxy" : "direct"} policy=${routePolicy} endpoint=${endpointHost} agent=${agentName} maxSockets=${agent ? maxSockets : 50} socketBufferBytes=${effectiveSocketBuffer} uploadSlots=${configuredUploadSlots} downloadSlots=${configuredDownloadSlots} browserDirectUpload=${directUploadPolicy.enabled} browserDirectUploadAddressing=${directUploadPolicy.addressingMode} browserDirectUploadOrigins=${directUploadPolicy.originCount} browserDirectUploadPerOrigin=${directUploadPolicy.connectionsPerOrigin} browserDirectUploadMax=${directUploadPolicy.maxConcurrency} browserDirectUploadTtlSeconds=${directUploadPolicy.expiresInSeconds} browserDirectDownload=${directDownloadPolicy.enabled} browserDirectDownloadMax=${directDownloadPolicy.maxConcurrency} browserDirectDownloadPartBytes=${directDownloadPolicy.partBytes} browserDirectDownloadMaxBufferBytes=${directDownloadPolicy.maxBufferBytes} browserDirectDownloadTtlSeconds=${directDownloadPolicy.expiresInSeconds} keepAlive=true expectContinue=false requestChecksum=${requestChecksumCalculation} responseChecksum=${responseChecksumValidation} optionalChecksumOptIn=${allowOptionalChecksums} globalAgentForce=${globalAgentForce} overrideRisk=${globalAgentForce !== "false"}`,
    );
    const requestHandler = agent
      ? new NodeHttpHandler({
          ...(isHttps ? { httpsAgent: agent } : { httpAgent: agent }),
          connectionTimeout: 30_000,
          socketTimeout: 600_000,
        })
      : undefined;
    const client = new S3Client({
      endpoint: endpoint || undefined,
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      forcePathStyle: true,
      requestChecksumCalculation,
      responseChecksumValidation,
      // Large UploadPart calls do not benefit from a proxy/S3 compatibility
      // handshake on a pre-authorized request. Recent SDK versions otherwise
      // add Expect: 100-continue above 2 MiB and Smithy can wait six seconds
      // before sending the body when an intermediary omits the 100 response.
      expectContinueHeader: false,
      ...(requestHandler ? { requestHandler } : {}),
    });
    // Assert the final serialized UploadPart request. If a future SDK upgrade
    // reintroduces aws-chunked/checksum trailers or drops Content-Length, fail
    // the part explicitly instead of silently collapsing aggregate throughput.
    if (requestChecksumCalculation === "WHEN_REQUIRED") {
      client.middlewareStack.add(
        (next, context) => async (args) => {
          if (context.commandName === "UploadPartCommand") {
            const request = args.request as {
              headers?: Record<string, string | undefined>;
            };
            const headers = Object.fromEntries(
              Object.entries(request.headers ?? {}).map(([name, value]) => [
                name.toLowerCase(),
                value,
              ]),
            );
            const contentEncoding = headers["content-encoding"] ?? "";
            if (
              !headers["content-length"] ||
              headers["transfer-encoding"] ||
              headers["x-amz-trailer"] ||
              contentEncoding
                .split(",")
                .some((value) => value.trim() === "aws-chunked")
            ) {
              throw new Error(
                `Unsafe S3 UploadPart wire format for data-plane ${S3_DATA_PLANE_REVISION}`,
              );
            }
          }
          return next(args);
        },
        {
          name: "privcloudUploadPartWireInvariant",
          step: "finalizeRequest",
          priority: "high",
        },
      );
    }
    this.s3Client = client;
    this.s3ClientCacheKey = cacheKey;
    return this.s3Client;
  }

  getS3TransportDiagnostics(): S3TransportDiagnostics {
    return { ...this.s3TransportDiagnostics };
  }

  private getS3TransportPoolMetrics(): string {
    const countEntries = (entries: unknown): number =>
      Object.values(
        (entries ?? {}) as Record<string, readonly unknown[] | undefined>,
      ).reduce((total, group) => total + (group?.length ?? 0), 0);
    const agent = this.s3TransportAgent;
    return (
      `proxyConnects=${this.s3ProxyConnects} ` +
      `proxyConnectFailures=${this.s3ProxyConnectFailures} ` +
      `poolActive=${agent ? countEntries(agent.sockets) : 0} ` +
      `poolFree=${agent ? countEntries(agent.freeSockets) : 0} ` +
      `poolQueued=${agent ? countEntries(agent.requests) : 0}`
    );
  }

  async getZip(shareId: string): Promise<Readable> {
    const s3Instance = this.getS3Instance();
    const bucketName = this.config.get("s3.bucketName");
    const compressionLevel = this.config.get("share.zipCompressionLevel");

    const files = await this.prisma.file.findMany({
      where: { shareId },
      orderBy: { name: "asc" },
    });

    if (files.length === 0) {
      throw new NotFoundException(`No files found for share ${shareId}`);
    }

    const archive = createZipArchive({
      zlib: { level: parseInt(compressionLevel) },
    });

    archive.on("error", (err) => {
      this.logger.error("Archive error", err);
    });

    const processNextFile = async (index: number) => {
      if (index >= files.length) {
        archive.finalize();
        return;
      }

      const fileRecord = files[index];
      const key = this.getShareObjectKey(shareId, fileRecord.id);
      let fileName: string;
      try {
        fileName = getArchiveEntryName(fileRecord);
      } catch {
        this.logger.warn(
          `Skipping file with unsafe archive path: shareId=${shareId} fileId=${fileRecord.id}`,
        );
        processNextFile(index + 1);
        return;
      }

      try {
        const response = await s3Instance.send(
          new GetObjectCommand({
            Bucket: bucketName,
            Key: key,
          }),
        );

        if (response.Body instanceof Readable) {
          const fileStream = response.Body;

          fileStream.on("end", () => {
            processNextFile(index + 1);
          });

          fileStream.on("error", (err) => {
            this.logger.error(`Error streaming file ${fileName}`, err);
            processNextFile(index + 1);
          });

          archive.append(fileStream, { name: fileName });
        } else {
          processNextFile(index + 1);
        }
      } catch (error) {
        this.logger.error(`Error processing file ${fileName}`, error);
        processNextFile(index + 1);
      }
    };

    processNextFile(0);
    return archive;
  }

  getS3Path(): string {
    const configS3Path = this.config.get("s3.bucketPath");
    return configS3Path ? `${configS3Path}/` : "";
  }

  /**
   * Retrieve an object from S3 using a raw key (not shareId/fileId pair).
   * Used by signing service to load/store PDFs at arbitrary paths.
   */
  async getRawObjectStream(rawKey: string): Promise<Readable> {
    const s3 = this.getS3Instance();
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: this.config.get("s3.bucketName"),
        Key: rawKey,
      }),
    );
    return response.Body as Readable;
  }

  /**
   * Store an object in S3 using a raw key.
   * Used by signing service to persist signed PDFs at arbitrary paths.
   */
  async putRawObject(
    rawKey: string,
    data: Buffer,
    contentType = "application/pdf",
  ): Promise<void> {
    const s3 = this.getS3Instance();
    await s3.send(
      new PutObjectCommand({
        Bucket: this.config.get("s3.bucketName"),
        Key: rawKey,
        Body: data,
        ContentType: contentType,
      }),
    );
  }
}
