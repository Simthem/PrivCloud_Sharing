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
    data: string,
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
    if (
      !file.name ||
      file.name.length > 255 ||
      /[\/\\]|\.{2}|\x00/.test(file.name)
    ) {
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

    const chunkBytes = Buffer.byteLength(data, "base64");

    // Max share size enforcement -- applies to both authenticated and
    // anonymous uploads, both S3 and local storage.  Uses the sum of
    // completed files in the DB + current chunk as a safety net.
    // LocalFileService has a more precise check using disk temp-file
    // sizes, but this common check is the primary enforcement for S3.
    const fileSizeSum = share.files.reduce(
      (n, { size }) => n + parseInt(size),
      0,
    );

    const effectiveLimit = share.reverseShare?.maxShareSize
      ? parseInt(share.reverseShare.maxShareSize)
      : Infinity;

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
    );

    return result;
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
    } finally {
      // Release lock on last chunk or on error
      if (chunk.index === chunk.total - 1) {
        this.reencryptingFiles.delete(fileId);
      }
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
