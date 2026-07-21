import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Logger,
  Param,
  PayloadTooLargeException,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import contentDisposition from "content-disposition";
import { Request, Response } from "express";
import { Share, User } from "@prisma/client";
import { BridgeUploadTokenService } from "src/bridgeUpload/bridge-upload-token.service";
import { CreateShareGuard } from "src/share/guard/createShare.guard";
import { ShareOwnerGuard } from "src/share/guard/shareOwner.guard";
import { DownloadNotificationService } from "src/downloadNotification/downloadNotification.service";
import { PrismaService } from "src/prisma/prisma.service";
import { FileService } from "./file.service";
import { FileSecurityGuard } from "./guard/fileSecurity.guard";
import * as mime from "mime-types";
import { SafeIdPipe } from "src/share/pipe/safeId.pipe";

const DEFAULT_MAX_UPLOAD_CHUNK_BYTES = 200_000_000;
const STREAMING_UPLOAD_CONTENT_TYPE = "application/vnd.privcloud.chunk";
const MAX_UPLOAD_CHUNK_BYTES = Math.max(
  1,
  parseInt(
    process.env.UPLOAD_MAX_CHUNK_BYTES || `${DEFAULT_MAX_UPLOAD_CHUNK_BYTES}`,
    10,
  ) || DEFAULT_MAX_UPLOAD_CHUNK_BYTES,
);
const ANONYMOUS_MAX_UPLOAD_CHUNK_BYTES = Math.min(
  MAX_UPLOAD_CHUNK_BYTES,
  Math.max(
    1,
    parseInt(process.env.UPLOAD_ANONYMOUS_MAX_CHUNK_BYTES || "120000000", 10) ||
      120_000_000,
  ),
);

@Controller("shares/:shareId/files")
export class FileController {
  private readonly logger = new Logger(FileController.name);

  constructor(
    private fileService: FileService,
    private downloadNotificationService: DownloadNotificationService,
    private prisma: PrismaService,
    private bridgeUploadTokenService: BridgeUploadTokenService,
  ) {}

  @Post()
  @Throttle({ default: { limit: 1000, ttl: 3600 } })
  @UseGuards(CreateShareGuard, ShareOwnerGuard)
  async create(
    @Query()
    query: {
      id: string;
      name?: string;
      relativePath?: string;
      chunkIndex: string;
      totalChunks: string;
      chunkSize?: string;
      encryptionChunkSize?: string;
    },
    @Headers("x-file-name") headerFileName: string | undefined,
    @Headers("x-file-relative-path") headerRelativePath: string | undefined,
    @Headers("content-length") contentLength: string | undefined,
    @Body() body: Buffer | undefined,
    @Param("shareId", SafeIdPipe) shareId: string,
    @Req() req: Request,
  ) {
    // Prefer X-File-Name header over query param to avoid WAF false positives
    // on filenames that look like command injection (e.g. containing dashes/dots).
    const name = headerFileName
      ? this.decodeHeaderValue(headerFileName, "file name")
      : query.name;
    const relativePath = headerRelativePath
      ? this.decodeHeaderValue(headerRelativePath, "file relative path")
      : query.relativePath;
    const maxChunkBytes = req.user
      ? MAX_UPLOAD_CHUNK_BYTES
      : ANONYMOUS_MAX_UPLOAD_CHUNK_BYTES;
    const {
      id,
      parsedChunkIndex,
      parsedTotalChunks,
      parsedChunkSize,
      parsedEncryptionChunkSize,
    } = this.parseUploadQuery(query, maxChunkBytes);

    // The first chunk uses application/octet-stream and negotiates the
    // transport. Subsequent S3 chunks use this unparsed media type so the
    // incoming request can be piped directly to UploadPart instead of being
    // fully buffered by Express first.
    if (this.isStreamingUpload(req)) {
      const parsedContentLength = this.parseStreamingContentLength(
        contentLength,
        maxChunkBytes,
      );
      return await this.fileService.createStream(
        req,
        parsedContentLength,
        { index: parsedChunkIndex, total: parsedTotalChunks },
        { id, name, relativePath },
        shareId,
        parsedChunkSize,
        parsedEncryptionChunkSize,
      );
    }

    this.assertChunkBodySize(body, maxChunkBytes);

    // Data can be empty if the file is empty
    return await this.fileService.create(
      body!,
      { index: parsedChunkIndex, total: parsedTotalChunks },
      { id, name, relativePath },
      shareId,
      parsedChunkSize,
      parsedEncryptionChunkSize,
    );
  }

  @Post("bridge")
  @Throttle({ default: { limit: 5000, ttl: 3600 } })
  async createViaBridge(
    @Query()
    query: {
      id: string;
      name?: string;
      relativePath?: string;
      chunkIndex: string;
      totalChunks: string;
      chunkSize?: string;
      encryptionChunkSize?: string;
    },
    @Headers("authorization") authorization: string | undefined,
    @Headers("x-file-name") headerFileName: string | undefined,
    @Headers("x-file-relative-path") headerRelativePath: string | undefined,
    @Body() body: Buffer,
    @Param("shareId", SafeIdPipe) shareId: string,
  ) {
    const token = this.getBearerToken(authorization);
    await this.bridgeUploadTokenService.validateToken(shareId, token);

    const name = headerFileName
      ? this.decodeHeaderValue(headerFileName, "file name")
      : query.name;
    const relativePath = headerRelativePath
      ? this.decodeHeaderValue(headerRelativePath, "file relative path")
      : query.relativePath;
    const {
      id,
      parsedChunkIndex,
      parsedTotalChunks,
      parsedChunkSize,
      parsedEncryptionChunkSize,
    } = this.parseUploadQuery(query, MAX_UPLOAD_CHUNK_BYTES);
    this.assertChunkBodySize(body, MAX_UPLOAD_CHUNK_BYTES);

    return await this.fileService.create(
      body,
      { index: parsedChunkIndex, total: parsedTotalChunks },
      { id, name, relativePath },
      shareId,
      parsedChunkSize,
      parsedEncryptionChunkSize,
    );
  }

  private decodeHeaderValue(value: string, label: string): string {
    try {
      return decodeURIComponent(value);
    } catch {
      throw new BadRequestException(`Invalid ${label} header`);
    }
  }

  private parseUploadQuery(
    query: {
      id: string;
      name?: string;
      relativePath?: string;
      chunkIndex: string;
      totalChunks: string;
      chunkSize?: string;
      encryptionChunkSize?: string;
    },
    maxChunkBytes: number,
  ) {
    const { id, chunkIndex, totalChunks, chunkSize, encryptionChunkSize } =
      query;
    const parsedChunkIndex = parseInt(chunkIndex, 10);
    const parsedTotalChunks = parseInt(totalChunks, 10);
    const parsedChunkSize = chunkSize ? parseInt(chunkSize, 10) : undefined;
    const parsedEncryptionChunkSize = encryptionChunkSize
      ? parseInt(encryptionChunkSize, 10)
      : undefined;

    if (
      !Number.isFinite(parsedChunkIndex) ||
      !Number.isFinite(parsedTotalChunks) ||
      parsedTotalChunks < 1 ||
      parsedTotalChunks > 10000 ||
      parsedChunkIndex < 0 ||
      parsedChunkIndex >= parsedTotalChunks
    ) {
      throw new BadRequestException("Invalid chunk parameters");
    }

    if (
      parsedChunkSize !== undefined &&
      (!Number.isFinite(parsedChunkSize) ||
        parsedChunkSize < 1 ||
        parsedChunkSize > maxChunkBytes)
    ) {
      throw new BadRequestException("Invalid chunkSize parameter");
    }

    if (
      parsedEncryptionChunkSize !== undefined &&
      (!Number.isFinite(parsedEncryptionChunkSize) ||
        parsedEncryptionChunkSize < 1_000_000 ||
        parsedEncryptionChunkSize > (parsedChunkSize ?? maxChunkBytes) ||
        parsedChunkSize === undefined ||
        parsedChunkSize % parsedEncryptionChunkSize !== 0)
    ) {
      throw new BadRequestException("Invalid encryptionChunkSize parameter");
    }

    return {
      id,
      parsedChunkIndex,
      parsedTotalChunks,
      parsedChunkSize,
      parsedEncryptionChunkSize,
    };
  }

  private isStreamingUpload(req: Request): boolean {
    return (
      req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ===
      STREAMING_UPLOAD_CONTENT_TYPE
    );
  }

  private parseStreamingContentLength(
    contentLength: string | undefined,
    maxChunkBytes: number,
  ): number {
    if (!contentLength || !/^\d+$/.test(contentLength)) {
      throw new BadRequestException(
        "A valid Content-Length header is required for streaming uploads",
      );
    }

    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed > maxChunkBytes + 28) {
      throw new PayloadTooLargeException(
        `Upload chunk exceeds the ${maxChunkBytes}-byte limit`,
      );
    }
    return parsed;
  }

  private assertChunkBodySize(body: Buffer | undefined, maxChunkBytes: number) {
    // AES-GCM chunks add a 12-byte IV and a 16-byte authentication tag.
    if (!Buffer.isBuffer(body)) {
      throw new BadRequestException("Missing upload chunk body");
    }
    if (body.length > maxChunkBytes + 28) {
      throw new PayloadTooLargeException(
        `Upload chunk exceeds the ${maxChunkBytes}-byte limit`,
      );
    }
  }

  private getBearerToken(authorization?: string): string {
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) throw new BadRequestException("Missing Bridge upload token");
    return match[1];
  }

  @Get("zip")
  @Throttle({ default: { limit: 5, ttl: 60 } })
  @UseGuards(FileSecurityGuard)
  async getZip(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("shareId", SafeIdPipe) shareId: string,
  ) {
    const zipStream = await this.fileService.getZip(shareId);

    // Zip = always a real download -> trigger notification
    const share = await this.prisma.share.findUnique({ where: { id: shareId } });
    if (share) {
      const isRegistered = !!(req as unknown as { user?: User }).user;
      void this.downloadNotificationService.onDownload(share, isRegistered);

      // Log team activity for team-folder zip downloads
      if (share.teamFolderId) {
        const folder = await this.prisma.teamFolder.findUnique({
          where: { id: share.teamFolderId },
          select: { teamId: true },
        });
        if (folder) {
          const downloader = (req as unknown as { user?: User }).user;
          this.prisma.teamAccessLog.create({
            data: {
              teamId: folder.teamId,
              action: "DOWNLOAD",
              actorEmail: downloader?.email || "anonymous",
              actorName: downloader?.username || undefined,
              fileName: `${shareId}.zip`,
              folderId: share.teamFolderId,
            },
          }).catch(err => this.logger.error(`Failed to log DOWNLOAD (zip): ${err.message}`));
        }
      }
    }

    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(`${shareId}.zip`),
      "X-Accel-Buffering": "no",
    });

    return new StreamableFile(zipStream);
  }

  @Get(":fileId")
  @UseGuards(FileSecurityGuard)
  async getFile(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("shareId", SafeIdPipe) shareId: string,
    @Param("fileId", SafeIdPipe) fileId: string,
    @Query("download") download = "true",
  ) {
    const authorizedShare = (
      req as Request & {
        authorizedShare?: Share;
      }
    ).authorizedShare;
    const file = await this.fileService.get(
      shareId,
      fileId,
      undefined,
      authorizedShare?.storageProvider,
    );

    const detectedMime =
      mime?.lookup?.(file.metaData.name) || "application/octet-stream";

    // MIME types that can execute scripts when rendered inline by a
    // browser.  Force download to prevent XSS even if CSP:sandbox
    // already blocks scripts (defense-in-depth).
    const DANGEROUS_MIME_TYPES = new Set([
      "image/svg+xml",
      "text/html",
      "application/xhtml+xml",
      "application/xml",
      "text/xml",
    ]);
    const forceDownload =
      download === "true" || DANGEROUS_MIME_TYPES.has(detectedMime);

    // For attachment downloads use application/octet-stream so that
    // intermediary proxies / WAFs (SafeLine, nginx gzip) do not try to
    // inspect, buffer, or compress the response body.  The browser uses
    // the filename from Content-Disposition, not Content-Type.
    const contentType = forceDownload ? "application/octet-stream" : detectedMime;

    // Only trigger download notification for actual downloads, not previews
    if (forceDownload) {
      const share = await this.prisma.share.findUnique({ where: { id: shareId } });
      if (share) {
        const isRegistered = !!(req as unknown as { user?: User }).user;
        void this.downloadNotificationService.onDownload(share, isRegistered);

        // Log team activity for team-folder downloads
        if (share.teamFolderId) {
          const folder = await this.prisma.teamFolder.findUnique({
            where: { id: share.teamFolderId },
            select: { teamId: true },
          });
          if (folder) {
            const downloader = (req as unknown as { user?: User }).user;
            this.prisma.teamAccessLog.create({
              data: {
                teamId: folder.teamId,
                action: "DOWNLOAD",
                actorEmail: downloader?.email || "anonymous",
                actorName: downloader?.username || undefined,
                fileName: file.metaData.name,
                fileSize: BigInt(file.metaData.size),
                folderId: share.teamFolderId,
              },
            }).catch(err => this.logger.error(`Failed to log DOWNLOAD: ${err.message}`));
          }
        }
      }
    }

    // --- Range request support (HTTP 206 Partial Content) ---
    const fileSize = parseInt(file.metaData.size);
    const rangeHeader = req.headers.range;
    let range: { start: number; end: number } | undefined;

    if (rangeHeader) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
        if (start < fileSize && start <= end) {
          range = { start, end: Math.min(end, fileSize - 1) };
        }
      }
      if (!range) {
        // Invalid range → 416 Range Not Satisfiable
        if (typeof (file.file as any).destroy === "function") {
          (file.file as any).destroy();
        }
        res.status(416).set({ "Content-Range": `bytes */${fileSize}` });
        res.end();
        return;
      }
    }

    // If a valid range was requested, replace the full stream with a ranged one
    if (range) {
      if (typeof (file.file as any).destroy === "function") {
        (file.file as any).destroy();
      }
      const rangedFile = await this.fileService.get(
        shareId,
        fileId,
        range,
        authorizedShare?.storageProvider,
      );

      const disposition = forceDownload
        ? contentDisposition(file.metaData.name)
        : contentDisposition(file.metaData.name, { type: "inline" });

      const rangeHeaders: Record<string, any> = {
        "Content-Type": forceDownload ? "application/octet-stream" : contentType,
        "Content-Range": `bytes ${range.start}-${range.end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": range.end - range.start + 1,
        "Content-Disposition": disposition,
        "Cache-Control": "private, no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "X-Accel-Buffering": "no",
      };
      // CSP sandbox only for inline preview (document context).
      // Setting it on fetch() responses causes WebKit to abort the stream.
      if (!forceDownload) {
        rangeHeaders["Content-Security-Policy"] = "sandbox";
      }
      if (file.metaData.encryptionChunkSize) {
        rangeHeaders["X-Encryption-Chunk-Size"] =
          file.metaData.encryptionChunkSize;
      }
      res.status(206).set(rangeHeaders);

      return new StreamableFile(rangedFile.file);
    }

    // --- Full response ---
    const headers: Record<string, any> = {
      "Content-Type": contentType,
      "Content-Length": fileSize,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "X-Accel-Buffering": "no",
    };

    // CSP sandbox only for inline preview (document context).
    // Setting it on fetch() responses causes WebKit to abort the stream.
    if (!forceDownload) {
      headers["Content-Security-Policy"] = "sandbox";
    }
    if (file.metaData.encryptionChunkSize) {
      headers["X-Encryption-Chunk-Size"] = file.metaData.encryptionChunkSize;
    }

    if (forceDownload) {
      headers["Content-Disposition"] = contentDisposition(file.metaData.name);
    } else {
      headers["Content-Disposition"] = contentDisposition(file.metaData.name, {
        type: "inline",
      });
    }

    res.set(headers);

    return new StreamableFile(file.file);
  }

  @Delete(":fileId")
  @Throttle({ default: { limit: 50, ttl: 60 } })
  @UseGuards(ShareOwnerGuard)
  async remove(
    @Param("fileId", SafeIdPipe) fileId: string,
    @Param("shareId", SafeIdPipe) shareId: string,
  ) {
    // Log team activity before deletion
    const share = await this.prisma.share.findUnique({ where: { id: shareId } });
    if (share?.teamFolderId) {
      const folder = await this.prisma.teamFolder.findUnique({
        where: { id: share.teamFolderId },
        select: { teamId: true },
      });
      const file = await this.prisma.file.findFirst({
        where: { id: fileId, shareId },
        select: { name: true, size: true },
      });
      if (folder && file) {
        this.prisma.teamAccessLog.create({
          data: {
            teamId: folder.teamId,
            action: "FILE_DELETE",
            actorEmail: share.creatorId || "unknown",
            fileName: file.name,
            fileSize: file.size ? BigInt(file.size) : undefined,
            folderId: share.teamFolderId,
          },
        }).catch(err => this.logger.error(`Failed to log FILE_DELETE: ${err.message}`));
      }
    }

    await this.fileService.remove(shareId, fileId);
  }

  @Put(":fileId/reencrypt")
  @Throttle({ default: { limit: 5000, ttl: 3600 } })
  @UseGuards(ShareOwnerGuard)
  async reencrypt(
    @Query()
    query: {
      chunkIndex: string;
      totalChunks: string;
      rotationId?: string;
      encryptionChunkSize?: string;
      sessionId?: string;
    },
    @Body() body: Buffer,
    @Param("shareId", SafeIdPipe) shareId: string,
    @Param("fileId", SafeIdPipe) fileId: string,
    @Req() req: Request,
  ) {
    const chunkIndex = parseInt(query.chunkIndex, 10);
    const totalChunks = parseInt(query.totalChunks, 10);
    const encryptionChunkSize = query.encryptionChunkSize
      ? parseInt(query.encryptionChunkSize, 10)
      : undefined;
    const reencryptSessionId = query.sessionId || "legacy";

    if (
      !Number.isFinite(chunkIndex) ||
      !Number.isFinite(totalChunks) ||
      totalChunks < 1 ||
      totalChunks > 10000 ||
      chunkIndex < 0 ||
      chunkIndex >= totalChunks
    ) {
      throw new BadRequestException("Invalid chunk parameters");
    }

    if (
      encryptionChunkSize !== undefined &&
      (!Number.isSafeInteger(encryptionChunkSize) ||
        encryptionChunkSize < 1_000_000 ||
        encryptionChunkSize > MAX_UPLOAD_CHUNK_BYTES)
    ) {
      throw new BadRequestException("Invalid encryptionChunkSize parameter");
    }
    if (
      query.sessionId &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        query.sessionId,
      )
    ) {
      throw new BadRequestException("Invalid re-encryption session ID");
    }

    // Large rotations use adaptive multipart parts (up to the authenticated
    // upload cap) to remain below S3's 10,000-part limit.
    if (body.length > MAX_UPLOAD_CHUNK_BYTES + 128) {
      throw new BadRequestException("Chunk payload too large");
    }

    await this.fileService.replaceFileContent(
      body,
      { index: chunkIndex, total: totalChunks },
      fileId,
      shareId,
      encryptionChunkSize,
      reencryptSessionId,
    );

    if (query.rotationId && chunkIndex === totalChunks - 1) {
      await this.recordTeamRotationFile(
        query.rotationId,
        shareId,
        fileId,
        (req as unknown as { user?: User }).user?.id,
      );
    }
  }

  private async recordTeamRotationFile(
    rotationId: string,
    shareId: string,
    fileId: string,
    userId?: string,
  ) {
    if (!/^[0-9a-f-]{36}$/i.test(rotationId) || !userId) {
      throw new BadRequestException("Invalid Team key rotation context");
    }
    const share = await this.prisma.share.findFirst({
      where: { id: shareId, teamFolderId: { not: null }, isE2EEncrypted: true },
      select: { teamFolder: { select: { teamId: true } } },
    });
    const teamId = share?.teamFolder?.teamId;
    if (!teamId)
      throw new BadRequestException("File is not part of an E2E Team share");

    const rotation = await this.prisma.teamKeyRotation.findFirst({
      where: {
        id: rotationId,
        teamId,
        startedById: userId,
        status: { in: ["PREPARING", "REENCRYPTING", "PAUSED"] },
      },
    });
    if (!rotation)
      throw new BadRequestException("Team key rotation is not active");

    let completed: string[] = [];
    try {
      const parsed = JSON.parse(rotation.completedFileIds);
      if (Array.isArray(parsed)) {
        completed = parsed.filter((item) => typeof item === "string");
      }
    } catch {
      completed = [];
    }
    if (!completed.includes(fileId)) completed.push(fileId);
    await this.prisma.teamKeyRotation.update({
      where: { id: rotation.id },
      data: {
        completedFileIds: JSON.stringify(completed),
        processedFiles: completed.length,
        status: "REENCRYPTING",
        failedFiles: 0,
        errorMessage: null,
      },
    });
  }
}
