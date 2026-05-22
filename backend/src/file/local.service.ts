import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import * as crypto from "crypto";
import { createReadStream } from "fs";
import * as fs from "fs/promises";
import * as mime from "mime-types";
import { ConfigService } from "src/config/config.service";
import { PrismaService } from "src/prisma/prisma.service";
import { validate as isValidUUID } from "uuid";
import { SHARE_DIRECTORY } from "../constants";
import { Readable } from "stream";

@Injectable()
export class LocalFileService {
  private readonly logger = new Logger(LocalFileService.name);

  // Cache plan limits per share to avoid a DB round-trip on every chunk.
  // Key: shareId, Value: { limit, ts }
  private planLimitCache = new Map<string, { limit: number; ts: number }>();
  private static readonly PLAN_LIMIT_TTL = 60_000; // 60s

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  async create(
    data: Buffer,
    chunk: { index: number; total: number },
    file: { id?: string; name: string },
    shareId: string,
    clientChunkSize?: number,
    share?: any,
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
    } else {
      this.logger.debug(
        `Upload continued: shareId=${shareId} fileId=${file.id} fileName="${file.name}"`,
      );
    }

    // Use share passed from file.service (avoids duplicate DB query)
    if (!share) {
      share = await this.prisma.share.findUnique({
        where: { id: shareId },
        include: { files: true, reverseShare: true },
      });
    }

    if (share.uploadLocked) {
      this.logger.warn(
        `Upload rejected, share completed: shareId=${shareId} fileId=${file.id}`,
      );
      throw new BadRequestException("Share is already completed");
    }

    // --- Parallelize independent I/O + DB lookups ---
    const tmpChunkPath = `${SHARE_DIRECTORY}/${shareId}/${file.id}.tmp-chunk`;
    const planOwnerId =
      share.reverseShare?.creatorId ?? share.creatorId ?? undefined;

    const [diskFileSize, space, effectiveLimit] = await Promise.all([
      // 1. Disk file size for chunk index validation
      fs.stat(tmpChunkPath).then((s) => s.size).catch(() => 0),
      // 2. Available disk space
      fs.statfs(SHARE_DIRECTORY),
      // 3. Plan limit (cached per share for 60s)
      this.getCachedPlanLimit(shareId, planOwnerId, share.reverseShare),
    ]);

    // If the sent chunk index and the expected chunk index doesn't match throw an error
    const configChunkSize = this.config.get("share.chunkSize");
    // Accept client-provided chunkSize for adaptive uploads, clamped
    // between 1 MB and 200 MB to prevent abuse.
    const MIN_CHUNK = 1_000_000;
    const MAX_CHUNK = 200_000_000;
    const chunkSize =
      clientChunkSize && clientChunkSize >= MIN_CHUNK && clientChunkSize <= MAX_CHUNK
        ? clientChunkSize
        : configChunkSize;
    // Chaque chunk E2E chiffré a 28 octets de surcharge (12 IV + 16 GCM tag)
    const effectiveChunkSize = share.isE2EEncrypted
      ? chunkSize + 28
      : chunkSize;
    const expectedChunkIndex = Math.ceil(diskFileSize / effectiveChunkSize);

    if (expectedChunkIndex != chunk.index) {
      this.logger.warn(
        `Unexpected chunk index: shareId=${shareId} fileId=${file.id} fileName="${file.name}" expected=${expectedChunkIndex} received=${chunk.index}`,
      );
      throw new BadRequestException({
        message: "Unexpected chunk received",
        error: "unexpected_chunk_index",
        expectedChunkIndex,
      });
    }

    // data is already a Buffer from Express raw body parser.
    // Avoid Buffer.from(data, "base64") which needlessly copies up to 200 MB.
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "base64");

    // Check if there is enough space on the server (space from parallel fetch)
    const availableSpace = space.bavail * space.bsize;
    if (availableSpace < buffer.byteLength) {
      this.logger.error(
        `Insufficient disk space: shareId=${shareId} fileId=${file.id} need=${buffer.byteLength} available=${availableSpace}`,
      );
      throw new InternalServerErrorException("Not enough space on the server");
    }

    // Check if share size limit is exceeded (effectiveLimit from parallel fetch)
    const fileSizeSum = share.files.reduce(
      (n, { size }) => n + parseInt(size),
      0,
    );

    const shareSizeSum = fileSizeSum + diskFileSize + buffer.byteLength;

    if (shareSizeSum > effectiveLimit) {
      throw new HttpException(
        "Max share size exceeded",
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    // Use file handle for direct write - avoids open/close overhead per chunk
    const fh = await fs.open(tmpChunkPath, "a");
    try {
      await fh.writeFile(buffer);
    } finally {
      await fh.close();
    }

    const isLastChunk = chunk.index == chunk.total - 1;
    this.logger.debug(
      `Chunk appended: shareId=${shareId} fileId=${file.id} fileName="${file.name}" chunkIndex=${chunk.index} chunkTotal=${chunk.total} last=${isLastChunk}`,
    );
    if (isLastChunk) {
      await fs.rename(
        tmpChunkPath,
        `${SHARE_DIRECTORY}/${shareId}/${file.id}`,
      );
      const fileSize = (
        await fs.stat(`${SHARE_DIRECTORY}/${shareId}/${file.id}`)
      ).size;
      await this.prisma.file.create({
        data: {
          id: file.id,
          name: file.name,
          size: fileSize.toString(),
          share: { connect: { id: shareId } },
        },
      });
      // Invalidate plan limit cache on upload complete
      this.planLimitCache.delete(shareId);
      this.logger.debug(
        `File uploaded: shareId=${shareId} fileId=${file.id} fileName="${file.name}" size=${fileSize} mimeType=${mime.contentType(file.name.split(".").pop() ?? "") || false}`,
      );
    }
    return file;
  }

  /**
   * Get effective plan limit, cached per shareId for PLAN_LIMIT_TTL.
   * Avoids a DB round-trip on every single chunk.
   */
  private async getCachedPlanLimit(
    shareId: string,
    planOwnerId: string | undefined,
    reverseShare?: { maxShareSize?: string | null } | null,
  ): Promise<number> {
    const cached = this.planLimitCache.get(shareId);
    if (cached && Date.now() - cached.ts < LocalFileService.PLAN_LIMIT_TTL) {
      return cached.limit;
    }
    // 0 (or absent env var) = no limit; positive value = cap in bytes
    const rawEnvLimit = process.env.TEAM_MAX_SHARE_SIZE
      ? parseInt(process.env.TEAM_MAX_SHARE_SIZE)
      : 0;
    const planLimit = rawEnvLimit > 0 ? rawEnvLimit : Infinity;
    const reverseShareLimit =
      reverseShare?.maxShareSize
        ? parseInt(reverseShare.maxShareSize)
        : Infinity;
    const limit = Math.min(planLimit, reverseShareLimit);
    this.planLimitCache.set(shareId, { limit, ts: Date.now() });
    return limit;
  }

  /**
   * Replace the content of an existing file (re-encryption).
   * Skips uploadLocked / quota checks and does NOT create a DB record.
   */
  async replace(
    data: string,
    chunk: { index: number; total: number },
    fileId: string,
    shareId: string,
  ) {
    if (!isValidUUID(fileId)) {
      throw new BadRequestException("Invalid file ID format");
    }

    const tmpPath = `${SHARE_DIRECTORY}/${shareId}/${fileId}.tmp-reencrypt`;
    const finalPath = `${SHARE_DIRECTORY}/${shareId}/${fileId}`;

    // On first chunk, remove any stale temp file
    if (chunk.index === 0) {
      try { await fs.unlink(tmpPath); } catch { /* no stale file */ }
    }

    const buffer = Buffer.from(data, "base64");

    await fs.appendFile(tmpPath, buffer);

    const isLastChunk = chunk.index === chunk.total - 1;
    this.logger.debug(
      `Reencrypt chunk: shareId=${shareId} fileId=${fileId} chunkIndex=${chunk.index} chunkTotal=${chunk.total} last=${isLastChunk}`,
    );

    if (isLastChunk) {
      await fs.rename(tmpPath, finalPath);
      const fileSize = (await fs.stat(finalPath)).size;
      // Update file size in DB (may differ slightly due to chunk alignment)
      await this.prisma.file.update({
        where: { id: fileId },
        data: { size: fileSize.toString() },
      });
      this.logger.debug(
        `Reencrypt complete: shareId=${shareId} fileId=${fileId} newSize=${fileSize}`,
      );
    }
  }

  async get(
    shareId: string,
    fileId: string,
    range?: { start: number; end: number },
  ) {
    const fileMetaData = await this.prisma.file.findUnique({
      where: { id: fileId },
    });

    if (!fileMetaData) throw new NotFoundException("File not found");

    const filePath = `${SHARE_DIRECTORY}/${shareId}/${fileId}`;
    const file = range
      ? createReadStream(filePath, { start: range.start, end: range.end, highWaterMark: 1_048_576 })
      : createReadStream(filePath, { highWaterMark: 1_048_576 });

    this.logger.debug(
      `File downloaded: shareId=${shareId} fileId=${fileMetaData.id} fileName="${fileMetaData.name}" size=${fileMetaData.size} range=${range ? `${range.start}-${range.end}` : "full"} mimeType=${mime.contentType(fileMetaData.name.split(".").pop() ?? "") || false}`,
    );

    return {
      metaData: {
        mimeType: mime.contentType(fileMetaData.name.split(".").pop()),
        ...fileMetaData,
        size: fileMetaData.size,
      },
      file,
    };
  }

  async remove(shareId: string, fileId: string) {
    const fileMetaData = await this.prisma.file.findUnique({
      where: { id: fileId },
    });

    if (!fileMetaData) throw new NotFoundException("File not found");

    await fs.unlink(`${SHARE_DIRECTORY}/${shareId}/${fileId}`);

    await this.prisma.file.delete({ where: { id: fileId } });
    this.logger.debug(
      `File deleted: shareId=${shareId} fileId=${fileMetaData.id} fileName="${fileMetaData.name}" size=${fileMetaData.size}`,
    );
  }

  async deleteAllFiles(shareId: string) {
    this.logger.debug(`Delete all files requested: shareId=${shareId}`);
    await fs.rm(`${SHARE_DIRECTORY}/${shareId}`, {
      recursive: true,
      force: true,
    });
  }

  async getZip(shareId: string): Promise<Readable> {
    return new Promise((resolve, reject) => {
      const zipStream = createReadStream(
        `${SHARE_DIRECTORY}/${shareId}/archive.zip`,
        { highWaterMark: 1_048_576 },
      );

      zipStream.on("error", (err) => {
        reject(new InternalServerErrorException(err));
      });

      zipStream.on("open", () => {
        resolve(zipStream);
      });
    });
  }
}
