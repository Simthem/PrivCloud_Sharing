import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { LocalFileService } from "./local.service";
import { S3FileService } from "./s3.service";
import { ConfigService } from "src/config/config.service";
import { Readable } from "stream";
import * as mime from "mime-types";
import { PrismaService } from "../prisma/prisma.service";
import {
  assertSafeFileName,
  normalizeUploadRelativePath,
} from "./file-path.util";
import { touchShareUploadActivity } from "src/share/upload-activity.util";

type MultipartUploadRequest = {
  id: string;
  name: string;
  relativePath?: string;
  totalChunks: number;
  fileSize: number;
  chunkSize: number;
  initialChunkSize: number;
  encryptionChunkSize?: number;
};

type MultipartPartAuthorizationRequest = {
  partIndex: number;
  contentLength: number;
};

@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);

  // Tracks the client session per file. The same session may restart at chunk
  // zero after a broken download, while a second tab remains blocked.
  private readonly reencryptingFiles = new Map<string, string>();

  // Cache instance-configured share limits to avoid reparsing configuration on
  // every chunk.
  // Key: shareId, Value: { limit, ts }
  private readonly shareLimitCache = new Map<
    string,
    { limit: number; ts: number }
  >();
  private static readonly SHARE_LIMIT_TTL = 60_000;

  constructor(
    private prisma: PrismaService,
    private localFileService: LocalFileService,
    private s3FileService: S3FileService,
    private configService: ConfigService,
  ) {}

  // Determine which service to use based on the current config value
  // shareId is optional -> can be used to overwrite a storage provider
  private getStorageService(
    storageProvider?: string,
  ): S3FileService | LocalFileService {
    if (storageProvider != undefined)
      return storageProvider == "S3"
        ? this.s3FileService
        : this.localFileService;
    return this.configService.get("s3.enabled")
      ? this.s3FileService
      : this.localFileService;
  }

  async initializeMultipartUpload(
    request: MultipartUploadRequest,
    shareId: string,
  ) {
    const file = {
      id: request.id,
      name: assertSafeFileName(request.name),
      relativePath: normalizeUploadRelativePath(
        request.relativePath,
        request.name,
      ),
    };
    const [share, existingFile] = await Promise.all([
      this.prisma.share.findUnique({
        where: { id: shareId },
        include: {
          files: { select: { size: true } },
          reverseShare: true,
        },
      }),
      this.prisma.file.findUnique({
        where: { id: request.id },
        select: { shareId: true },
      }),
    ]);
    if (!share) throw new NotFoundException("Share not found");
    if (existingFile?.shareId === shareId) {
      this.s3FileService.unregisterUploadFlow(shareId, request.id);
      return {
        ...file,
        uploadComplete: true,
        alreadyCompleted: true,
      };
    }
    if (existingFile) {
      throw new BadRequestException("File ID is already in use");
    }
    if (share.uploadLocked) {
      throw new BadRequestException("Share is already completed");
    }
    await touchShareUploadActivity(this.prisma, share);

    const storageService = this.getStorageService(share.storageProvider);
    if (storageService !== this.s3FileService) {
      return {
        id: request.id,
        initialized: false,
        uploadTransport: "buffered",
        uploadConcurrency: 1,
        uploadWindowMode: "local-sequential",
      };
    }

    const effectiveLimit = this.getCachedShareLimit(shareId, share);
    const existingBytes = share.files.reduce(
      (total, current) => total + parseInt(current.size),
      0,
    );
    if (existingBytes + request.fileSize > effectiveLimit) {
      throw new HttpException(
        "Max share size exceeded",
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    try {
      const initialized = await this.s3FileService.initializeMultipartUpload(
        file,
        shareId,
        request.totalChunks,
      );
      const directUpload = this.s3FileService.getBrowserDirectUploadPolicy();
      const directAllocation = directUpload.enabled
        ? this.s3FileService.getBrowserDirectUploadAllocation(
            shareId,
            initialized.id,
          )
        : this.s3FileService.getUploadAllocation(
            shareId,
            initialized.id,
            false,
          );
      const relayAllocation = this.s3FileService.getUploadAllocation(
        shareId,
        initialized.id,
        false,
      );
      return {
        ...initialized,
        uploadTransport: directUpload.enabled ? "direct-s3" : "stream",
        uploadConcurrency: Math.min(
          directAllocation.recommendedSlots,
          directUpload.maxConcurrency,
        ),
        uploadGlobalConcurrency: Math.min(
          directAllocation.targetSlots,
          directUpload.maxConcurrency,
        ),
        uploadRelayFallbackConcurrency: Math.max(
          1,
          Math.min(
            relayAllocation.recommendedSlots,
            relayAllocation.targetSlots,
          ),
        ),
        uploadRelayGlobalConcurrency: relayAllocation.targetSlots,
        uploadActiveFlows: directAllocation.activeFlows,
        uploadFairShare: directAllocation.fairShare,
        uploadWindowMode: directUpload.enabled
          ? "browser-origin-pool"
          : "server-adaptive-fair",
        directUpload,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `Multipart initialization failed: shareId=${shareId} fileId=${request.id}`,
        error instanceof Error ? error.stack : error,
      );
      throw new HttpException(
        "S3 upload temporarily unavailable",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  async authorizeMultipartPartUpload(
    request: MultipartUploadRequest,
    shareId: string,
    partIndex: number,
    contentLength: number,
  ) {
    const result = await this.authorizeMultipartPartsUpload(request, shareId, [
      { partIndex, contentLength },
    ]);
    const { parts: authorizations, ...window } = result;
    return {
      ...authorizations[0],
      ...window,
    };
  }

  async authorizeMultipartPartsUpload(
    request: MultipartUploadRequest,
    shareId: string,
    parts: MultipartPartAuthorizationRequest[],
  ) {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      select: {
        id: true,
        storageProvider: true,
        uploadLocked: true,
        uploadLastActivityAt: true,
        uploadCleanupStartedAt: true,
      },
    });
    if (!share) throw new NotFoundException("Share not found");
    if (share.uploadLocked) {
      throw new BadRequestException("Share is already completed");
    }
    await touchShareUploadActivity(this.prisma, share);
    if (this.getStorageService(share.storageProvider) !== this.s3FileService) {
      throw new NotFoundException(
        "Direct multipart upload is unavailable for this share",
      );
    }

    const authorizations =
      await this.s3FileService.createMultipartPartUploadUrls(
        request.id,
        shareId,
        request.totalChunks,
        parts,
      );
    const directUpload = this.s3FileService.getBrowserDirectUploadPolicy();
    const directAllocation =
      this.s3FileService.getBrowserDirectUploadAllocation(shareId, request.id);
    const relayAllocation = this.s3FileService.getUploadAllocation(
      shareId,
      request.id,
      false,
    );
    return {
      id: request.id,
      parts: authorizations,
      uploadTransport: "direct-s3",
      uploadConcurrency: Math.min(
        directAllocation.recommendedSlots,
        directUpload.maxConcurrency,
      ),
      uploadGlobalConcurrency: Math.min(
        directAllocation.targetSlots,
        directUpload.maxConcurrency,
      ),
      uploadRelayFallbackConcurrency: Math.max(
        1,
        Math.min(relayAllocation.recommendedSlots, relayAllocation.targetSlots),
      ),
      uploadRelayGlobalConcurrency: relayAllocation.targetSlots,
      uploadActiveFlows: directAllocation.activeFlows,
      uploadFairShare: directAllocation.fairShare,
      uploadWindowMode: "browser-origin-pool",
      directUpload,
    };
  }

  async authorizeBrowserDownload(
    shareId: string,
    fileId: string,
    storageProvider: string | undefined,
    download: boolean,
  ) {
    const metadata = await this.prisma.file.findFirst({
      where: { id: fileId, shareId },
      select: {
        name: true,
        size: true,
        encryptionChunkSize: true,
        share: {
          select: {
            teamFolderId: true,
          },
        },
      },
    });
    if (!metadata) throw new NotFoundException("File not found");

    const fileSize = Number(metadata.size);
    if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
      throw new HttpException(
        "Invalid stored file size",
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    const directPolicy = this.s3FileService.getBrowserDirectDownloadPolicy();
    if (
      !directPolicy.enabled ||
      this.getStorageService(storageProvider) !== this.s3FileService
    ) {
      return { direct: false as const };
    }

    const detectedMime =
      mime.lookup(metadata.name) || "application/octet-stream";
    const dangerousMimeTypes = new Set([
      "image/svg+xml",
      "text/html",
      "application/xhtml+xml",
      "application/xml",
      "text/xml",
    ]);
    const forceDownload =
      download || dangerousMimeTypes.has(String(detectedMime));
    const contentType = forceDownload
      ? "application/octet-stream"
      : String(detectedMime);
    const signed = await this.s3FileService.createBrowserDownloadUrl(
      shareId,
      fileId,
      metadata.name,
      forceDownload,
      contentType,
    );
    const configuredDirectDownloadPartBytes = directPolicy.partBytes;
    const directDownloadMaxBufferBytes = directPolicy.maxBufferBytes;
    const physicalDirectDownloadConcurrency = Math.min(
      directPolicy.maxConcurrency,
      signed.candidates.length * 6,
    );
    const directDownloadPartBytes = Math.min(
      configuredDirectDownloadPartBytes,
      Math.max(
        1024 * 1024,
        Math.floor(
          directDownloadMaxBufferBytes / physicalDirectDownloadConcurrency,
        ),
      ),
    );
    const directDownloadConcurrency = Math.min(
      physicalDirectDownloadConcurrency,
      Math.max(
        1,
        Math.floor(directDownloadMaxBufferBytes / directDownloadPartBytes),
      ),
    );
    return {
      direct: true as const,
      ...signed,
      fileName: metadata.name,
      size: fileSize,
      encryptionChunkSize: metadata.encryptionChunkSize
        ? Number(metadata.encryptionChunkSize)
        : null,
      directDownloadConcurrency,
      directDownloadPartBytes,
      directDownloadThresholdBytes: Math.max(
        directPolicy.thresholdBytes,
        directDownloadPartBytes * 2,
      ),
      directDownloadMaxBufferBytes,
      forceDownload,
      contentType,
    };
  }

  /**
   * Finalize from S3's authoritative part list.
   *
   * No individual Nest process is required to have observed every ETag. S3 is
   * authoritative, and the SQLite transaction makes retries after a lost
   * proxy response idempotent.
   */
  async completeMultipartUpload(
    request: MultipartUploadRequest,
    shareId: string,
  ) {
    const file = {
      id: request.id,
      name: assertSafeFileName(request.name),
      relativePath: normalizeUploadRelativePath(
        request.relativePath,
        request.name,
      ),
    };
    const [share, existingFile] = await Promise.all([
      this.prisma.share.findUnique({
        where: { id: shareId },
        include: {
          files: { select: { size: true } },
          reverseShare: true,
        },
      }),
      this.prisma.file.findUnique({
        where: { id: request.id },
        select: { shareId: true },
      }),
    ]);
    if (!share) throw new NotFoundException("Share not found");
    if (existingFile?.shareId === shareId) {
      this.s3FileService.unregisterUploadFlow(shareId, request.id);
      return {
        ...file,
        uploadComplete: true,
        alreadyCompleted: true,
      };
    }
    if (existingFile) {
      throw new BadRequestException("File ID is already in use");
    }
    if (share.uploadLocked) {
      throw new BadRequestException("Share is already completed");
    }
    await touchShareUploadActivity(this.prisma, share);
    if (this.getStorageService(share.storageProvider) !== this.s3FileService) {
      throw new BadRequestException(
        "Multipart completion is only available for S3-backed shares",
      );
    }

    const effectiveLimit = this.getCachedShareLimit(shareId, share);
    const existingBytes = share.files.reduce(
      (total, current) => total + parseInt(current.size),
      0,
    );
    if (existingBytes + request.fileSize > effectiveLimit) {
      throw new HttpException(
        "Max share size exceeded",
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    const result = await this.s3FileService.completeMultipartUpload(
      file,
      shareId,
      request.totalChunks,
      share,
      effectiveLimit,
      request.encryptionChunkSize,
    );
    this.shareLimitCache.delete(shareId);
    return result;
  }

  async create(
    data: Buffer,
    chunk: { index: number; total: number },
    file: {
      id?: string;
      name: string;
      relativePath?: string;
    },
    shareId: string,
    clientChunkSize?: number,
    encryptionChunkSize?: number,
  ) {
    return this.createInternal(
      data,
      data.length,
      false,
      chunk,
      file,
      shareId,
      clientChunkSize,
      encryptionChunkSize,
    );
  }

  async createStream(
    data: Readable,
    contentLength: number,
    chunk: { index: number; total: number },
    file: {
      id?: string;
      name: string;
      relativePath?: string;
    },
    shareId: string,
    clientChunkSize?: number,
    encryptionChunkSize?: number,
  ) {
    return this.createInternal(
      data,
      contentLength,
      true,
      chunk,
      file,
      shareId,
      clientChunkSize,
      encryptionChunkSize,
    );
  }

  private async createInternal(
    data: Buffer | Readable,
    chunkBytes: number,
    streaming: boolean,
    chunk: { index: number; total: number },
    file: {
      id?: string;
      name: string;
      relativePath?: string;
    },
    shareId: string,
    clientChunkSize?: number,
    encryptionChunkSize?: number,
  ) {
    // Validate the display filename and optional logical folder path.
    // Physical storage still uses file.id only; relativePath is metadata for
    // UI display and safe ZIP entry names.
    file.name = assertSafeFileName(file.name);
    file.relativePath = normalizeUploadRelativePath(
      file.relativePath,
      file.name,
    );

    // Fetch the share with related data for all common validations
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: {
        files: { select: { size: true } },
        reverseShare: true,
      },
    });

    if (!share) {
      throw new NotFoundException("Share not found");
    }

    // Reject uploads to already-completed shares (was missing for S3)
    if (share.uploadLocked) {
      this.logger.warn(`Upload rejected, share completed: shareId=${shareId}`);
      throw new BadRequestException("Share is already completed");
    }
    await touchShareUploadActivity(this.prisma, share);

    const effectiveEncryptionChunkSize = share.isE2EEncrypted
      ? (encryptionChunkSize ??
        clientChunkSize ??
        this.configService.get("share.chunkSize"))
      : undefined;

    const effectiveLimit = this.getCachedShareLimit(shareId, share);

    // Max share size enforcement -- applies to both authenticated and
    // anonymous uploads, both S3 and local storage.
    // Pre-check: fast non-transactional reject for obviously oversized uploads.
    // The actual atomic size check + file.create happens inside the storage
    // service on the last chunk (transactional, closes the race completely).
    // The share query above already returned the current file sizes. Re-querying
    // the same relation on every part added a full database round-trip to the
    // hot upload path without strengthening the final, transactional size
    // check performed by the storage service.
    const fileSizeSum = share.files.reduce(
      (n, { size }) => n + parseInt(size),
      0,
    );

    if (fileSizeSum + chunkBytes > effectiveLimit) {
      this.logger.warn(
        `Max share size exceeded: shareId=${shareId} current=${fileSizeSum} ` +
          `chunk=${chunkBytes} limit=${effectiveLimit}`,
      );
      throw new HttpException(
        "Max share size exceeded",
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    const storageService = this.getStorageService(share.storageProvider);
    const isS3 = storageService === this.s3FileService;
    if (streaming && !isS3) {
      throw new UnsupportedMediaTypeException(
        "Streaming chunks are only available for S3-backed shares",
      );
    }

    const storageResult = isS3
      ? await this.s3FileService.create(
          data,
          chunk,
          file,
          shareId,
          clientChunkSize,
          share,
          effectiveLimit,
          chunkBytes,
          effectiveEncryptionChunkSize,
        )
      : await this.localFileService.create(
          data as Buffer,
          chunk,
          file,
          shareId,
          clientChunkSize,
          share,
          effectiveLimit,
          effectiveEncryptionChunkSize,
        );
    const uploadComplete =
      isS3 &&
      (storageResult as { uploadComplete?: boolean }).uploadComplete === true;
    const { uploadComplete: _uploadComplete, ...result } = storageResult as {
      uploadComplete?: boolean;
      id?: string;
      name?: string;
      relativePath?: string;
    };

    // Invalidate the configured-limit cache when upload is complete.
    if (chunk.index === chunk.total - 1) {
      this.shareLimitCache.delete(shareId);
    }

    if (!isS3) {
      return {
        ...result,
        uploadTransport: "buffered",
        uploadConcurrency: 1,
        uploadWindowMode: "local-sequential",
      };
    }

    const allocation = this.s3FileService.getUploadAllocation(
      shareId,
      result.id ?? file.id!,
      true,
    );
    if (uploadComplete) {
      this.s3FileService.unregisterUploadFlow(shareId, result.id ?? file.id!);
    }
    return {
      ...result,
      uploadTransport: "stream",
      uploadConcurrency: allocation.recommendedSlots,
      uploadGlobalConcurrency: allocation.targetSlots,
      uploadActiveFlows: allocation.activeFlows,
      uploadFairShare: allocation.fairShare,
      uploadWindowMode: "server-adaptive-fair",
    };
  }

  /**
   * Resolve the instance-configured limit. Reverse-share and Team limits are
   * ordinary self-hosting controls.
   */
  private getCachedShareLimit(
    shareId: string,
    share: any,
  ): number {
    const cached = this.shareLimitCache.get(shareId);
    if (cached && Date.now() - cached.ts < FileService.SHARE_LIMIT_TTL) {
      return cached.limit;
    }

    const configuredLimit = Number(this.configService.get("share.maxSize"));
    const reverseShareLimit = share.reverseShare?.maxShareSize
      ? parseInt(share.reverseShare.maxShareSize)
      : Infinity;
    const teamMaxShareSize = parseInt(
      process.env.TEAM_MAX_SHARE_SIZE || "0",
    );
    const teamLimit =
      share.teamFolderId && teamMaxShareSize > 0 ? teamMaxShareSize : Infinity;

    const limit = Math.min(
      Number.isFinite(configuredLimit) && configuredLimit > 0
        ? configuredLimit
        : Infinity,
      reverseShareLimit,
      teamLimit,
    );
    this.shareLimitCache.set(shareId, { limit, ts: Date.now() });
    return limit;
  }

  /**
   * Replace file content for re-encryption.
   * Validates share ownership and E2E state without repeating the configured
   * size-limit check performed by multipart initialization.
   */
  async replaceFileContent(
    data: Buffer,
    chunk: { index: number; total: number },
    fileId: string,
    shareId: string,
    encryptionChunkSize?: number,
    reencryptSessionId = "legacy",
  ) {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
    });

    if (!share) {
      throw new NotFoundException("Share not found");
    }

    if (!share.isE2EEncrypted) {
      throw new BadRequestException("Share is not E2E encrypted");
    }

    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
    });

    if (!file || file.shareId !== shareId) {
      throw new NotFoundException("File not found in this share");
    }

    // Prevent concurrent re-encryption of the same file
    const activeSession = this.reencryptingFiles.get(fileId);
    if (chunk.index === 0) {
      if (activeSession && activeSession !== reencryptSessionId) {
        this.logger.warn(
          `Replacing stale re-encryption session: fileId=${fileId}`,
        );
      }
      this.reencryptingFiles.set(fileId, reencryptSessionId);
    } else if (activeSession !== reencryptSessionId) {
      throw new BadRequestException(
        "No re-encryption session found for this file",
      );
    }

    try {
      const storageService = this.getStorageService(share.storageProvider);
      await storageService.replace(
        data,
        chunk,
        fileId,
        shareId,
        encryptionChunkSize,
      );
    } catch (error) {
      // Keep the session so a transient network/S3 failure can retry the same
      // chunk. A deliberate restart at chunk zero replaces a stale session.
      this.logger.error(
        `replaceFileContent failed (session retained): shareId=${shareId} fileId=${fileId} chunk=${chunk.index}/${chunk.total}`,
        error instanceof Error ? error.stack : error,
      );
      throw error;
    }

    // Release lock on successful last chunk
    if (chunk.index === chunk.total - 1) {
      if (this.reencryptingFiles.get(fileId) === reencryptSessionId) {
        this.reencryptingFiles.delete(fileId);
      }
    }
  }

  async get(
    shareId: string,
    fileId: string,
    range?: { start: number; end: number },
    storageProvider?: string,
  ): Promise<File> {
    const storageService = storageProvider
      ? this.getStorageService(storageProvider)
      : await this.getShareStorageService(shareId);
    return storageService.get(shareId, fileId, range);
  }

  async remove(shareId: string, fileId: string) {
    const storageService = await this.getShareStorageService(shareId);
    return storageService.remove(shareId, fileId);
  }

  async deleteAllFiles(shareId: string, storageProvider?: string) {
    const storageService = storageProvider
      ? this.getStorageService(storageProvider)
      : await this.getShareStorageService(shareId);
    return storageService.deleteAllFiles(shareId);
  }

  async getRecentUploadActivity(
    shareId: string,
    storageProvider: string,
    since: Date,
  ): Promise<Date | null> {
    return this.getStorageService(storageProvider).getRecentUploadActivity(
      shareId,
      since,
    );
  }

  async getZip(shareId: string): Promise<Readable> {
    const storageService = await this.getShareStorageService(shareId);
    return await storageService.getZip(shareId);
  }

  private async getShareStorageService(
    shareId: string,
  ): Promise<S3FileService | LocalFileService> {
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      select: { storageProvider: true },
    });
    if (!share) throw new NotFoundException("Share not found");
    return this.getStorageService(share.storageProvider);
  }

  /**
   * Purge stale S3 multipart uploads. Only relevant when S3 is enabled.
   * Called from jobs.service.ts on a schedule.
   */
  async cleanupStaleS3Multiparts() {
    if (this.configService.get("s3.enabled")) {
      await this.s3FileService.cleanupStaleS3Multiparts();
    }
  }

  private async streamToUint8Array(stream: Readable): Promise<Uint8Array> {
    const chunks: Buffer[] = [];

    return new Promise((resolve, reject) => {
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
      stream.on("error", reject);
    });
  }

  /**
   * Validate that a storage key is safe (no path traversal).
   */
  private validateStorageKey(key: string): void {
    if (
      !key ||
      key.includes("..") ||
      key.includes("\x00") ||
      key.startsWith("/") ||
      key.startsWith("\\")
    ) {
      throw new BadRequestException("Invalid storage key");
    }
  }

  /**
   * Retrieve a file by a custom key (used for signing documents).
   * The key is a storage path like "signing/{id}/document.pdf".
   */
  async getFileByKey(key: string): Promise<Buffer> {
    this.validateStorageKey(key);
    const storageService = this.getStorageService();
    if (storageService instanceof S3FileService) {
      const stream = await storageService.getRawObjectStream(key);
      return Buffer.from(await this.streamToUint8Array(stream));
    }
    // Local: read directly
    const fs = await import("fs/promises");
    const path = await import("path");
    const dataDir = this.configService.get("general.dataDir") || "./data";
    const baseDir = path.resolve(dataDir);
    const filePath = path.resolve(dataDir, key);
    if (!filePath.startsWith(baseDir + path.sep)) {
      throw new BadRequestException(
        "Invalid storage key - path traversal detected",
      );
    }
    return fs.readFile(filePath);
  }

  /**
   * Store a file by a custom key (used for signing documents).
   * The key is a storage path like "signing/{id}/signed.pdf".
   */
  async storeFileByKey(key: string, data: Buffer): Promise<void> {
    this.validateStorageKey(key);
    const storageService = this.getStorageService();
    if (storageService instanceof S3FileService) {
      await storageService.putRawObject(key, data);
      return;
    }
    // Local: write directly
    const fs = await import("fs/promises");
    const path = await import("path");
    const dataDir = this.configService.get("general.dataDir") || "./data";
    const baseDir = path.resolve(dataDir);
    const filePath = path.resolve(dataDir, key);
    if (!filePath.startsWith(baseDir + path.sep)) {
      throw new BadRequestException(
        "Invalid storage key - path traversal detected",
      );
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data);
  }
}

export interface File {
  metaData: {
    id: string;
    size: string;
    createdAt: Date;
    mimeType: string | false;
    name: string;
    shareId: string;
    relativePath?: string | null;
    encryptionChunkSize?: number | null;
  };
  file: Readable;
}
