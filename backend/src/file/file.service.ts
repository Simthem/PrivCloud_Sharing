import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { LocalFileService } from "./local.service";
import { S3FileService } from "./s3.service";
import { ConfigService } from "src/config/config.service";
import { Readable } from "stream";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);

  // Tracks files currently being re-encrypted to prevent concurrent operations
  private readonly reencryptingFiles = new Set<string>();

  // Cache configured limits per share to avoid DB round-trips on every chunk.
  // Key: shareId, Value: { limit, ts }
  private readonly configuredLimitCache = new Map<
    string,
    { limit: number; ts: number }
  >();
  private static readonly CONFIGURED_LIMIT_TTL = 60_000; // 60s

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

  async create(
    data: Buffer,
    chunk: { index: number; total: number },
    file: {
      id?: string;
      name: string;
    },
    shareId: string,
    clientChunkSize?: number,
  ) {
    // Sanitize filename: strip path separators, null bytes, ".." sequences,
    // and enforce a reasonable length limit (CWE-23, CWE-73 mitigation).
    const hasUnsafeFileName =
      file.name.includes("\0") ||
      file.name.includes("..") ||
      file.name.includes("/") ||
      file.name.includes("\\");
    if (!file.name || file.name.length > 255 || hasUnsafeFileName) {
      throw new BadRequestException("Invalid file name");
    }

    // Fetch the share with related data for all common validations
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
      include: { files: true, reverseShare: true },
    });

    if (!share) {
      throw new NotFoundException("Share not found");
    }

    // Reject uploads to already-completed shares (was missing for S3)
    if (share.uploadLocked) {
      this.logger.warn(
        `Upload rejected, share completed: shareId=${shareId}`,
      );
      throw new BadRequestException("Share is already completed");
    }

    const chunkBytes = Buffer.isBuffer(data)
      ? data.length
      : Buffer.byteLength(data, "base64");

    // When uploading via a reverse share, the configured limit owner is the
    // reverse share creator, not the possibly anonymous share creator.
    const limitOwnerId =
      share.reverseShare?.creatorId ?? share.creatorId ?? undefined;

    // --- Parallelize quota check + configured limit lookup (both hit DB) ---
    const [, effectiveLimit] = await Promise.all([
      // 1. Storage quota check on first chunk only
      limitOwnerId && chunk.index === 0
        ? Promise.resolve()
        : Promise.resolve(),
      // 2. Configured limit (cached per share for 60s)
      this.getCachedConfiguredLimit(shareId, share),
    ]);

    // Max share size enforcement -- applies to both authenticated and
    // anonymous uploads, both S3 and local storage.
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

    const storageService = this.getStorageService();
    const result = await storageService.create(
      data,
      chunk,
      file,
      shareId,
      clientChunkSize,
      share,
    );

    // Invalidate configured limit cache when upload is complete.
    if (chunk.index === chunk.total - 1) {
      this.configuredLimitCache.delete(shareId);
    }

    return result;
  }

  /**
   * Cached configured limit lookup -- avoids a DB round-trip on every chunk.
   */
  private async getCachedConfiguredLimit(
    shareId: string,
    share: any,
  ): Promise<number> {
    const cached = this.configuredLimitCache.get(shareId);
    if (
      cached &&
      Date.now() - cached.ts < FileService.CONFIGURED_LIMIT_TTL
    ) {
      return cached.limit;
    }

    // 0 (or absent env var) = no limit; positive value = cap in bytes
    const rawEnvLimit = process.env.TEAM_MAX_SHARE_SIZE
      ? parseInt(process.env.TEAM_MAX_SHARE_SIZE)
      : 0;
    const configuredLimit = rawEnvLimit > 0 ? rawEnvLimit : Infinity;
    const reverseShareLimit = share.reverseShare?.maxShareSize
      ? parseInt(share.reverseShare.maxShareSize)
      : Infinity;
    const teamLimit = share.teamFolderId
      ? (rawEnvLimit > 0 ? rawEnvLimit : Infinity)
      : Infinity;

    const limit = Math.min(configuredLimit, reverseShareLimit, teamLimit);
    this.configuredLimitCache.set(shareId, { limit, ts: Date.now() });
    return limit;
  }

  /**
   * Replace file content for re-encryption.
   * Validates share ownership and E2E flag but skips uploadLocked and quota.
   */
  async replaceFileContent(
    data: string,
    chunk: { index: number; total: number },
    fileId: string,
    shareId: string,
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
    if (chunk.index === 0) {
      if (this.reencryptingFiles.has(fileId)) {
        throw new BadRequestException(
          "Re-encryption already in progress for this file",
        );
      }
      this.reencryptingFiles.add(fileId);
    } else if (!this.reencryptingFiles.has(fileId)) {
      throw new BadRequestException(
        "No re-encryption session found for this file",
      );
    }

    try {
      const storageService = this.getStorageService(share.storageProvider);
      await storageService.replace(data, chunk, fileId, shareId);
    } catch (error) {
      // Release lock immediately on ANY error so the client can retry
      // from chunk 0 without being blocked by a stale lock.
      this.reencryptingFiles.delete(fileId);
      this.logger.error(
        `replaceFileContent failed: shareId=${shareId} fileId=${fileId} chunk=${chunk.index}/${chunk.total}`,
        error instanceof Error ? error.stack : error,
      );
      throw error;
    }

    // Release lock on successful last chunk
    if (chunk.index === chunk.total - 1) {
      this.reencryptingFiles.delete(fileId);
    }
  }

  async get(
    shareId: string,
    fileId: string,
    range?: { start: number; end: number },
  ): Promise<File> {
    const share = await this.prisma.share.findFirst({
      where: { id: shareId },
    });
    const storageService = this.getStorageService(share.storageProvider);
    return storageService.get(shareId, fileId, range);
  }

  async remove(shareId: string, fileId: string) {
    const storageService = this.getStorageService();
    return storageService.remove(shareId, fileId);
  }

  async deleteAllFiles(shareId: string) {
    const storageService = this.getStorageService();
    return storageService.deleteAllFiles(shareId);
  }

  async getZip(shareId: string): Promise<Readable> {
    const storageService = this.getStorageService();
    return await storageService.getZip(shareId);
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
      throw new BadRequestException("Invalid storage key - path traversal detected");
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
      throw new BadRequestException("Invalid storage key - path traversal detected");
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
  };
  file: Readable;
}
