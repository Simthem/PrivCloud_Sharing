import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Logger,
  Param,
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
import { User } from "@prisma/client";
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
const MAX_UPLOAD_CHUNK_BYTES = Math.max(
  1,
  parseInt(
    process.env.UPLOAD_MAX_CHUNK_BYTES || `${DEFAULT_MAX_UPLOAD_CHUNK_BYTES}`,
    10,
  ) || DEFAULT_MAX_UPLOAD_CHUNK_BYTES,
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
      chunkIndex: string;
      totalChunks: string;
      chunkSize?: string;
    },
    @Headers("x-file-name") headerFileName: string | undefined,
    @Body() body: Buffer,
    @Param("shareId", SafeIdPipe) shareId: string,
  ) {
    // Prefer X-File-Name header over query param to avoid WAF false positives
    // on filenames that look like command injection (e.g. containing dashes/dots).
    const name = headerFileName
      ? decodeURIComponent(headerFileName)
      : query.name;
    const { id, parsedChunkIndex, parsedTotalChunks, parsedChunkSize } =
      this.parseUploadQuery(query);

    // Data can be empty if the file is empty
    return await this.fileService.create(
      body,
      { index: parsedChunkIndex, total: parsedTotalChunks },
      { id, name },
      shareId,
      parsedChunkSize,
    );
  }

  @Post("bridge")
  @Throttle({ default: { limit: 5000, ttl: 3600 } })
  async createViaBridge(
    @Query()
    query: {
      id: string;
      name?: string;
      chunkIndex: string;
      totalChunks: string;
      chunkSize?: string;
    },
    @Headers("authorization") authorization: string | undefined,
    @Headers("x-file-name") headerFileName: string | undefined,
    @Body() body: Buffer,
    @Param("shareId", SafeIdPipe) shareId: string,
  ) {
    const token = this.getBearerToken(authorization);
    await this.bridgeUploadTokenService.validateToken(shareId, token);

    const name = headerFileName
      ? decodeURIComponent(headerFileName)
      : query.name;
    const { id, parsedChunkIndex, parsedTotalChunks, parsedChunkSize } =
      this.parseUploadQuery(query);

    return await this.fileService.create(
      body,
      { index: parsedChunkIndex, total: parsedTotalChunks },
      { id, name },
      shareId,
      parsedChunkSize,
    );
  }

  private parseUploadQuery(query: {
    id: string;
    name?: string;
    chunkIndex: string;
    totalChunks: string;
    chunkSize?: string;
  }) {
    const { id, chunkIndex, totalChunks, chunkSize } = query;
    const parsedChunkIndex = parseInt(chunkIndex, 10);
    const parsedTotalChunks = parseInt(totalChunks, 10);
    const parsedChunkSize = chunkSize ? parseInt(chunkSize, 10) : undefined;

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
        parsedChunkSize > MAX_UPLOAD_CHUNK_BYTES)
    ) {
      throw new BadRequestException("Invalid chunkSize parameter");
    }

    return { id, parsedChunkIndex, parsedTotalChunks, parsedChunkSize };
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
    const file = await this.fileService.get(shareId, fileId);

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
      const rangedFile = await this.fileService.get(shareId, fileId, range);

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
    },
    @Body() body: string,
    @Param("shareId", SafeIdPipe) shareId: string,
    @Param("fileId", SafeIdPipe) fileId: string,
  ) {
    const chunkIndex = parseInt(query.chunkIndex, 10);
    const totalChunks = parseInt(query.totalChunks, 10);

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

    // Reject unreasonably large base64 payloads (max ~15 MB base64 = ~11 MB raw)
    if (body.length > 15_000_000) {
      throw new BadRequestException("Chunk payload too large");
    }

    await this.fileService.replaceFileContent(
      body,
      { index: chunkIndex, total: totalChunks },
      fileId,
      shareId,
    );
  }
}
