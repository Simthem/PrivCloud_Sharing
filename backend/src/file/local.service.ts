import {
  FILE_META_V1,
  encryptedFilePlaceholderName,
} from "./file-metadata-scheme";
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import * as crypto from "crypto";
import { createReadStream, Stats } from "fs";
import * as fs from "fs/promises";
import * as mime from "mime-types";
import * as path from "path";
import { ConfigService } from "src/config/config.service";
import { PrismaService } from "src/prisma/prisma.service";
import { validate as isValidUUID } from "uuid";
import { SHARE_DIRECTORY } from "../constants";
import { Readable } from "stream";
import { MAX_UPLOAD_CHUNK_BYTES } from "./upload-limit.util";
import { contentHeaderBytes, ContentScheme } from "./content-scheme.util";

// link() reports these where the filesystem has no hard links.
const HARD_LINK_UNSUPPORTED = new Set([
  "EPERM",
  "ENOTSUP",
  "EOPNOTSUPP",
  "ENOSYS",
  "EXDEV",
]);
// An upload lock older than this was left by a process that stopped.
const UPLOAD_LOCK_STALE_MS = 15 * 60_000;
const UPLOAD_LOCK_WAIT_MS = 30_000;

@Injectable()
export class LocalFileService {
  private readonly logger = new Logger(LocalFileService.name);

  // Chunks of one upload are checked, appended and published in order,
  // within this process first and then across processes sharing the volume.
  private readonly uploadQueues = new Map<string, Promise<unknown>>();

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  private resolveSharePath(shareId: string, ...segments: string[]): string {
    const allSegments = [shareId, ...segments];
    const safeSegments = allSegments.map((segment) => {
      if (
        typeof segment !== "string" ||
        segment.length === 0 ||
        segment.length > 255 ||
        !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(segment) ||
        path.basename(segment) !== segment
      ) {
        throw new BadRequestException("Invalid storage identifier");
      }
      return path.basename(segment);
    });
    const [safeShareId, ...safeChildren] = safeSegments;

    const root = path.resolve(SHARE_DIRECTORY);
    const resolved = path.resolve(root, safeShareId, ...safeChildren);
    const expectedShareRoot = path.resolve(root, safeShareId);
    if (
      resolved !== expectedShareRoot &&
      !resolved.startsWith(`${expectedShareRoot}${path.sep}`)
    ) {
      throw new BadRequestException("Invalid storage path");
    }
    return resolved;
  }

  async create(
    data: Buffer,
    chunk: { index: number; total: number },
    file: {
      id?: string;
      name: string;
      relativePath?: string;
      metadataScheme?: number | null;
      encryptedMetadata?: string | null;
      contentScheme?: ContentScheme;
    },
    shareId: string,
    clientChunkSize?: number,
    share?: any,
    callerEffectiveLimit?: number,
    encryptionChunkSize?: number,
  ) {
    const originalFileId = file.id;
    if (!file.id) {
      file.id = crypto.randomUUID();
      this.logger.debug(
        `Upload started: share=redacted fileId=${file.id} note="generated fileId"`,
      );
    } else if (!isValidUUID(file.id)) {
      this.logger.warn(
        `Invalid fileId format on upload: share=redacted fileId="${originalFileId}"`,
      );
      throw new BadRequestException("Invalid file ID format");
    } else {
      this.logger.debug(`Upload continued: share=redacted fileId=${file.id}`);
    }

    const lockPath = this.resolveSharePath(
      shareId,
      `${file.id}.lock.tmp-chunk`,
    );
    return this.serializeUpload(lockPath, () =>
      this.appendChunk(
        data,
        chunk,
        file,
        shareId,
        clientChunkSize,
        share,
        callerEffectiveLimit,
        encryptionChunkSize,
      ),
    );
  }

  private async appendChunk(
    data: Buffer,
    chunk: { index: number; total: number },
    file: {
      id?: string;
      name: string;
      relativePath?: string;
      metadataScheme?: number | null;
      encryptedMetadata?: string | null;
      contentScheme?: ContentScheme;
    },
    shareId: string,
    clientChunkSize?: number,
    share?: any,
    callerEffectiveLimit?: number,
    encryptionChunkSize?: number,
  ) {
    // Use share passed from file.service (avoids duplicate DB query)
    if (!share) {
      share = await this.prisma.share.findUnique({
        where: { id: shareId },
        include: { files: true, reverseShare: true },
      });
    }

    // An identifier names one immutable file. As on S3, a retried or
    // duplicated upload of a completed file leaves it untouched.
    const existingFile = await this.prisma.file.findUnique({
      where: { id: file.id },
      select: { shareId: true },
    });
    if (existingFile?.shareId === shareId) return file;
    if (existingFile) {
      throw new BadRequestException("File ID is already in use");
    }

    if (share.uploadLocked) {
      this.logger.warn(
        `Upload rejected, share completed: share=redacted fileId=${file.id}`,
      );
      throw new BadRequestException("Share is already completed");
    }

    // --- Parallelize independent I/O + DB lookups ---
    const tmpChunkPath = this.resolveSharePath(shareId, `${file.id}.tmp-chunk`);
    const [diskFileSize, space] = await Promise.all([
      // 1. Disk file size for chunk index validation
      fs
        .stat(tmpChunkPath)
        .then((s) => s.size)
        .catch(() => 0),
      // 2. Available disk space
      fs.statfs(SHARE_DIRECTORY),
    ]);

    // FileService normally supplies the effective self-hosted instance limit.
    // Keep a local fallback for direct internal callers.
    const configuredLimit = Number(this.config.get("share.maxSize"));
    const reverseShareLimit = share.reverseShare?.maxShareSize
      ? parseInt(share.reverseShare.maxShareSize)
      : Infinity;
    const effectiveLimit =
      callerEffectiveLimit ??
      Math.min(
        Number.isFinite(configuredLimit) && configuredLimit > 0
          ? configuredLimit
          : Infinity,
        reverseShareLimit,
      );

    // If the sent chunk index and the expected chunk index doesn't match throw an error
    const configChunkSize = this.config.get("share.chunkSize");
    // Accept client-provided chunkSize for adaptive uploads, clamped
    // between 1 MB and the configured upload ceiling to prevent abuse.
    const MIN_CHUNK = 1_000_000;
    const chunkSize =
      clientChunkSize &&
      clientChunkSize >= MIN_CHUNK &&
      clientChunkSize <= MAX_UPLOAD_CHUNK_BYTES
        ? clientChunkSize
        : configChunkSize;
    const cryptoRecordSize = encryptionChunkSize ?? chunkSize;
    const recordsPerTransportChunk = Math.ceil(chunkSize / cryptoRecordSize);
    // A transport chunk can contain several independently authenticated
    // AES-GCM records. Account for every 12-byte IV + 16-byte tag when
    // validating the append position on local storage.
    const effectiveChunkSize = share.isE2EEncrypted
      ? chunkSize + recordsPerTransportChunk * 28
      : chunkSize;
    // The E2EE content v2 header precedes the records of the first chunk.
    const headerBytes =
      diskFileSize > 0 ? contentHeaderBytes(file.contentScheme, 0) : 0;
    const expectedChunkIndex = Math.ceil(
      (diskFileSize - headerBytes) / effectiveChunkSize,
    );

    if (expectedChunkIndex != chunk.index) {
      this.logger.warn(
        `Unexpected chunk index: share=redacted fileId=${file.id} expected=${expectedChunkIndex} received=${chunk.index}`,
      );
      throw new BadRequestException({
        message: "Unexpected chunk received",
        error: "unexpected_chunk_index",
        expectedChunkIndex,
      });
    }

    // data is already a Buffer from Express raw body parser.
    // Avoid Buffer.from(data, "base64") which needlessly copies large chunks.
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "base64");

    // Check if there is enough space on the server (space from parallel fetch)
    const availableSpace = space.bavail * space.bsize;
    if (availableSpace < buffer.byteLength) {
      this.logger.error(
        `Insufficient disk space: share=redacted fileId=${file.id} need=${buffer.byteLength} available=${availableSpace}`,
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
      `Chunk appended: share=redacted fileId=${file.id} chunkIndex=${chunk.index} chunkTotal=${chunk.total} last=${isLastChunk}`,
    );
    if (isLastChunk) {
      const finalPath = this.resolveSharePath(shareId, file.id);
      const published = await this.publishWithoutReplacing(
        tmpChunkPath,
        finalPath,
      );
      if (!published) {
        await fs.rm(tmpChunkPath, { force: true });
        const owner = await this.prisma.file.findUnique({
          where: { id: file.id },
          select: { shareId: true },
        });
        if (owner?.shareId === shareId) return file;
        throw new BadRequestException("File ID is already in use");
      }
      const fileSize = published.size;

      // SQLite serializes writers, so the interactive transaction closes the
      // completion race inside the serialized SQLite transaction.
      try {
        await this.prisma.$transaction(async (tx) => {
          const freshShare = await tx.share.findUnique({
            where: { id: shareId },
            select: { files: { select: { size: true } } },
          });
          const currentSize = (freshShare?.files ?? []).reduce(
            (n, { size }) => n + parseInt(size),
            0,
          );
          if (currentSize + fileSize > effectiveLimit) {
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
              metadataScheme: file.metadataScheme ?? null,
              encryptedMetadata: file.encryptedMetadata ?? null,
              size: fileSize.toString(),
              encryptionChunkSize: share.isE2EEncrypted
                ? cryptoRecordSize
                : null,
              contentScheme: file.contentScheme ?? null,
              share: { connect: { id: shareId } },
            },
          });
        });
      } catch (error) {
        // Without a readable outcome the commit may have succeeded, so the
        // published file is kept rather than risk orphaning a record.
        const owner = await this.prisma.file
          .findUnique({ where: { id: file.id }, select: { shareId: true } })
          .catch(() => undefined);
        if (owner?.shareId === shareId) return file;
        if (owner !== undefined) {
          await this.removeIfUnchanged(finalPath, published);
        }
        if ((error as { code?: string })?.code === "P2002") {
          throw new BadRequestException("File ID is already in use");
        }
        throw error;
      }

      this.logger.debug(
        `File uploaded: share=redacted fileId=${file.id} size=${fileSize} mimeType=${mime.contentType(file.name.split(".").pop() ?? "") || false}`,
      );
    }
    return file;
  }

  private async serializeUpload<T>(
    key: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.uploadQueues.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.holdUploadLock(key, task));
    this.uploadQueues.set(key, current);
    try {
      return await current;
    } finally {
      if (this.uploadQueues.get(key) === current) {
        this.uploadQueues.delete(key);
      }
    }
  }

  /**
   * An exclusively created lock file serializes one upload between backend
   * processes. Its .tmp-chunk suffix lets the daily cleanup remove a lock
   * left behind by a process that stopped.
   */
  private async holdUploadLock<T>(
    lockPath: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + UPLOAD_LOCK_WAIT_MS;
    let lock: Stats;
    for (;;) {
      try {
        const handle = await fs.open(lockPath, "wx");
        lock = await handle.stat();
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const held = await fs.stat(lockPath).catch(() => null);
      if (held && Date.now() - held.mtimeMs > UPLOAD_LOCK_STALE_MS) {
        await this.removeIfUnchanged(lockPath, held);
        continue;
      }
      if (Date.now() > deadline) {
        throw new ServiceUnavailableException(
          "This upload chunk is still being written, retry it",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try {
      return await task();
    } finally {
      await this.removeIfUnchanged(lockPath, lock).catch(() => undefined);
    }
  }

  /**
   * Publish a completed upload under its final name without ever replacing an
   * existing file. link() creates the name atomically or fails with EEXIST,
   * also between backend processes sharing the volume. Filesystems without
   * hard links get an exclusive create and a copy instead. A published name
   * is only served once its database record exists. Returns null when the
   * name is already taken.
   */
  private async publishWithoutReplacing(
    source: string,
    target: string,
  ): Promise<Stats | null> {
    try {
      await this.linkFile(source, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return null;
      if (!HARD_LINK_UNSUPPORTED.has(code)) throw error;
      return this.copyWithoutReplacing(source, target);
    }
    const published = await fs.stat(target);
    await fs.rm(source, { force: true });
    return published;
  }

  private linkFile(source: string, target: string) {
    return fs.link(source, target);
  }

  private async copyWithoutReplacing(
    source: string,
    target: string,
  ): Promise<Stats | null> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(target, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
    const created = await handle.stat();
    try {
      for await (const part of createReadStream(source, {
        highWaterMark: 1_048_576,
      })) {
        await handle.write(part as Buffer);
      }
      const published = await handle.stat();
      await handle.close();
      await fs.rm(source, { force: true });
      return published;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await this.removeIfUnchanged(target, created);
      throw error;
    }
  }

  /** Remove a name only while it still designates the given file. */
  private async removeIfUnchanged(target: string, expected: Stats) {
    const current = await fs.stat(target).catch(() => null);
    if (current?.dev === expected.dev && current.ino === expected.ino) {
      await fs.unlink(target);
    }
  }

  /**
   * Replace the content of an existing file (re-encryption).
   * Skips completion and configured size checks and does NOT create a DB record.
   */
  async replace(
    data: Buffer,
    chunk: { index: number; total: number },
    fileId: string,
    shareId: string,
    encryptionChunkSize?: number,
    contentScheme?: ContentScheme,
    encryptedMetadata?: string,
  ) {
    if (!isValidUUID(fileId)) {
      throw new BadRequestException("Invalid file ID format");
    }

    const tmpPath = this.resolveSharePath(shareId, `${fileId}.tmp-reencrypt`);
    const finalPath = this.resolveSharePath(shareId, fileId);

    // On first chunk, remove any stale temp file
    if (chunk.index === 0) {
      try {
        await fs.unlink(tmpPath);
      } catch {
        /* no stale file */
      }
    }

    const buffer = data;

    await fs.appendFile(tmpPath, buffer);

    const isLastChunk = chunk.index === chunk.total - 1;
    this.logger.debug(
      `Reencrypt chunk: share=redacted fileId=${fileId} chunkIndex=${chunk.index} chunkTotal=${chunk.total} last=${isLastChunk}`,
    );

    if (isLastChunk) {
      await fs.rename(tmpPath, finalPath);
      const fileSize = (await fs.stat(finalPath)).size;
      // Update file size in DB (may differ slightly due to chunk alignment)
      const updated = await this.prisma.file.updateMany({
        where: { id: fileId, shareId },
        data: {
          size: fileSize.toString(),
          encryptionChunkSize: encryptionChunkSize ?? null,
          contentScheme: contentScheme ?? null,
          ...(encryptedMetadata !== undefined && {
            encryptedMetadata,
            metadataScheme: FILE_META_V1,
            name: encryptedFilePlaceholderName(fileId),
            relativePath: null,
          }),
        },
      });
      if (updated.count !== 1) {
        throw new NotFoundException("File not found in this share");
      }
      this.logger.debug(
        `Reencrypt complete: share=redacted fileId=${fileId} newSize=${fileSize}`,
      );
    }
  }

  async get(
    shareId: string,
    fileId: string,
    range?: { start: number; end: number },
  ) {
    const fileMetaData = await this.prisma.file.findFirst({
      where: { id: fileId, shareId },
    });

    if (!fileMetaData) throw new NotFoundException("File not found");

    const filePath = this.resolveSharePath(shareId, fileId);
    const file = range
      ? createReadStream(filePath, {
          start: range.start,
          end: range.end,
          highWaterMark: 1_048_576,
        })
      : createReadStream(filePath, { highWaterMark: 1_048_576 });

    this.logger.debug(
      `File downloaded: share=redacted fileId=${fileMetaData.id} size=${fileMetaData.size} range=${range ? `${range.start}-${range.end}` : "full"} mimeType=${mime.contentType(fileMetaData.name.split(".").pop() ?? "") || false}`,
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
    const fileMetaData = await this.prisma.file.findFirst({
      where: { id: fileId, shareId },
    });

    if (!fileMetaData) throw new NotFoundException("File not found");

    try {
      await fs.unlink(this.resolveSharePath(shareId, fileId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      this.logger.warn(
        `Stored file already absent for share=redacted fileId=${fileId}; removing the database record`,
      );
    }

    await this.prisma.file.delete({ where: { id: fileId } });
    this.logger.debug(
      `File deleted: share=redacted fileId=${fileMetaData.id} size=${fileMetaData.size}`,
    );
  }

  async deleteAllFiles(shareId: string) {
    this.logger.debug("Delete all share files requested");
    await fs.rm(this.resolveSharePath(shareId), {
      recursive: true,
      force: true,
    });
  }

  /**
   * Return the newest physical write under an unfinished share. This protects
   * local uploads served by an older application process that predates database
   * heartbeats.
   */
  async getRecentUploadActivity(
    shareId: string,
    since: Date,
  ): Promise<Date | null> {
    const sharePath = this.resolveSharePath(shareId);
    let names: string[];
    try {
      names = await fs.readdir(sharePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }

    let newest = 0;
    await Promise.all(
      names.map(async (name) => {
        try {
          const stat = await fs.stat(this.resolveSharePath(shareId, name));
          newest = Math.max(newest, stat.mtimeMs);
        } catch (error) {
          // A concurrently renamed temporary part is expected and will be
          // represented by either its old or final path on the next probe.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }),
    );

    return newest >= since.getTime() ? new Date(newest) : null;
  }

  async getZip(shareId: string): Promise<Readable> {
    return new Promise((resolve, reject) => {
      const zipStream = createReadStream(
        this.resolveSharePath(shareId, "archive.zip"),
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
