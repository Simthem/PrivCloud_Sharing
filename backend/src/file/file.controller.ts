import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  InternalServerErrorException,
  Logger,
  NotFoundException,
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
import { hours, minutes, Throttle } from "@nestjs/throttler";
import contentDisposition from "content-disposition";
import { Request, Response } from "express";
import { Share, User } from "@prisma/client";
import { BridgeUploadTokenService } from "src/bridgeUpload/bridge-upload-token.service";
import { CreateShareGuard } from "src/share/guard/createShare.guard";
import { ShareOwnerGuard } from "src/share/guard/shareOwner.guard";
import { DownloadNotificationService } from "src/downloadNotification/downloadNotification.service";
import { PrismaService } from "src/prisma/prisma.service";
import { TeamNotificationService } from "src/teamNotification/teamNotification.service";
import { FileService } from "./file.service";
import { FileSecurityGuard } from "./guard/fileSecurity.guard";
import * as mime from "mime-types";
import { SafeIdPipe } from "src/share/pipe/safeId.pipe";
import {
  getMaxUploadPayloadBytes,
  getUploadChunkLimit,
  MAX_UPLOAD_CHUNK_BYTES,
} from "./upload-limit.util";

const STREAMING_UPLOAD_CONTENT_TYPE = "application/vnd.privcloud.chunk";
const S3_MIN_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
const MAX_MULTIPART_PART_AUTHORIZATIONS = 32;

type MultipartInitializationBody = {
  id?: unknown;
  name?: unknown;
  relativePath?: unknown;
  totalChunks?: unknown;
  fileSize?: unknown;
  chunkSize?: unknown;
  initialChunkSize?: unknown;
  encryptionChunkSize?: unknown;
};

type MultipartPartAuthorizationBody = MultipartInitializationBody & {
  chunkIndex?: unknown;
  contentLength?: unknown;
};

type MultipartPartsAuthorizationBody = MultipartInitializationBody & {
  parts?: unknown;
};

export type FileByteRange = { start: number; end: number };

type ParsedMultipartInitialization = {
  id: string;
  name: string;
  relativePath?: string;
  totalChunks: number;
  fileSize: number;
  chunkSize: number;
  initialChunkSize: number;
  encryptionChunkSize?: number;
};

export function getMultipartPartPayloadLength(
  request: ParsedMultipartInitialization,
  chunkIndex: number,
): number {
  if (
    !Number.isSafeInteger(chunkIndex) ||
    chunkIndex < 0 ||
    chunkIndex >= request.totalChunks
  ) {
    throw new BadRequestException("Invalid multipart chunk index");
  }
  const start =
    chunkIndex === 0
      ? 0
      : request.initialChunkSize + (chunkIndex - 1) * request.chunkSize;
  const plainLength = Math.min(
    chunkIndex === 0 ? request.initialChunkSize : request.chunkSize,
    request.fileSize - start,
  );
  if (!Number.isSafeInteger(plainLength) || plainLength <= 0) {
    throw new BadRequestException("Invalid multipart chunk layout");
  }
  return getMaxUploadPayloadBytes(
    plainLength,
    plainLength,
    request.encryptionChunkSize,
  );
}

export function parseSingleByteRange(
  rangeHeader: string,
  fileSize: number,
): FileByteRange | undefined {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) return undefined;

  // Deliberately support one range only. Multipart byte-range responses add
  // complexity and are unnecessary for the download and preview clients.
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match || (!match[1] && !match[2])) return undefined;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return undefined;
    }
    return {
      start: Math.max(fileSize - suffixLength, 0),
      end: fileSize - 1,
    };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : fileSize - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= fileSize ||
    requestedEnd < start
  ) {
    return undefined;
  }

  return { start, end: Math.min(requestedEnd, fileSize - 1) };
}

@Controller("shares/:shareId/files")
export class FileController {
  private readonly logger = new Logger(FileController.name);

  constructor(
    private fileService: FileService,
    private downloadNotificationService: DownloadNotificationService,
    private prisma: PrismaService,
    private teamNotificationService: TeamNotificationService,
    private bridgeUploadTokenService: BridgeUploadTokenService,
  ) {}

  @Post("multipart/init")
  @Throttle({ default: { limit: 10_000, ttl: hours(1) } })
  @UseGuards(CreateShareGuard, ShareOwnerGuard)
  async initializeMultipartUpload(
    @Body() body: MultipartInitializationBody | undefined,
    @Param("shareId", SafeIdPipe) shareId: string,
    @Req() req: Request,
  ) {
    const maxChunkBytes = getUploadChunkLimit(!!req.user);
    const request = this.parseMultipartInitialization(body, maxChunkBytes);
    return this.fileService.initializeMultipartUpload(request, shareId);
  }

  @Post("multipart/part-url")
  @Throttle({ default: { limit: 20_000, ttl: hours(1) } })
  @UseGuards(CreateShareGuard, ShareOwnerGuard)
  async authorizeMultipartPartUpload(
    @Body() body: MultipartPartAuthorizationBody | undefined,
    @Param("shareId", SafeIdPipe) shareId: string,
    @Req() req: Request,
  ) {
    const maxChunkBytes = getUploadChunkLimit(!!req.user);
    const request = this.parseMultipartInitialization(body, maxChunkBytes);
    const chunkIndex = body?.chunkIndex;
    const contentLength = body?.contentLength;
    if (
      !Number.isSafeInteger(chunkIndex) ||
      !Number.isSafeInteger(contentLength)
    ) {
      throw new BadRequestException(
        "Invalid multipart part authorization",
      );
    }
    const expectedContentLength = getMultipartPartPayloadLength(
      request,
      chunkIndex as number,
    );
    if (contentLength !== expectedContentLength) {
      throw new BadRequestException(
        "Multipart part Content-Length does not match the declared layout",
      );
    }
    return this.fileService.authorizeMultipartPartUpload(
      request,
      shareId,
      chunkIndex as number,
      expectedContentLength,
    );
  }

  @Post("multipart/part-urls")
  @Throttle({ default: { limit: 10_000, ttl: hours(1) } })
  @UseGuards(CreateShareGuard, ShareOwnerGuard)
  async authorizeMultipartPartsUpload(
    @Body() body: MultipartPartsAuthorizationBody | undefined,
    @Param("shareId", SafeIdPipe) shareId: string,
    @Req() req: Request,
  ) {
    const maxChunkBytes = getUploadChunkLimit(!!req.user);
    const request = this.parseMultipartInitialization(body, maxChunkBytes);
    if (
      !Array.isArray(body?.parts) ||
      body.parts.length < 1 ||
      body.parts.length > MAX_MULTIPART_PART_AUTHORIZATIONS
    ) {
      throw new BadRequestException(
        "Invalid multipart parts authorization",
      );
    }

    const seenChunkIndexes = new Set<number>();
    const parts = body.parts.map((part) => {
      const chunkIndex =
        part && typeof part === "object"
          ? (part as { chunkIndex?: unknown }).chunkIndex
          : undefined;
      const contentLength =
        part && typeof part === "object"
          ? (part as { contentLength?: unknown }).contentLength
          : undefined;
      if (
        !Number.isSafeInteger(chunkIndex) ||
        !Number.isSafeInteger(contentLength) ||
        seenChunkIndexes.has(chunkIndex as number)
      ) {
        throw new BadRequestException(
          "Invalid multipart parts authorization",
        );
      }
      const expectedContentLength = getMultipartPartPayloadLength(
        request,
        chunkIndex as number,
      );
      if (contentLength !== expectedContentLength) {
        throw new BadRequestException(
          "Multipart part Content-Length does not match the declared layout",
        );
      }
      seenChunkIndexes.add(chunkIndex as number);
      return {
        partIndex: chunkIndex as number,
        contentLength: expectedContentLength,
      };
    });

    return this.fileService.authorizeMultipartPartsUpload(
      request,
      shareId,
      parts,
    );
  }

  @Post("multipart/complete")
  @Throttle({ default: { limit: 10_000, ttl: hours(1) } })
  @UseGuards(CreateShareGuard, ShareOwnerGuard)
  async completeMultipartUpload(
    @Body() body: MultipartInitializationBody | undefined,
    @Param("shareId", SafeIdPipe) shareId: string,
    @Req() req: Request,
  ) {
    const maxChunkBytes = getUploadChunkLimit(!!req.user);
    const request = this.parseMultipartInitialization(body, maxChunkBytes);
    return this.fileService.completeMultipartUpload(request, shareId);
  }

  @Post()
  @Throttle({ default: { limit: 10_000, ttl: hours(1) } })
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
    const maxChunkBytes = getUploadChunkLimit(!!req.user);
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
        parsedChunkSize,
        parsedEncryptionChunkSize,
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

    this.assertChunkBodySize(
      body,
      maxChunkBytes,
      parsedChunkSize,
      parsedEncryptionChunkSize,
    );

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
  @Throttle({ default: { limit: 10_000, ttl: hours(1) } })
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
    this.assertChunkBodySize(
      body,
      MAX_UPLOAD_CHUNK_BYTES,
      parsedChunkSize,
      parsedEncryptionChunkSize,
    );

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

  private parseMultipartInitialization(
    body: MultipartInitializationBody | undefined,
    maxChunkBytes: number,
  ): ParsedMultipartInitialization {
    if (!body || typeof body !== "object") {
      throw new BadRequestException("Missing multipart initialization body");
    }
    const {
      id,
      name,
      relativePath,
      totalChunks,
      fileSize,
      chunkSize,
      initialChunkSize,
      encryptionChunkSize,
    } = body;
    if (typeof id !== "string" || typeof name !== "string") {
      throw new BadRequestException("Invalid multipart file metadata");
    }
    if (
      relativePath !== undefined &&
      relativePath !== null &&
      typeof relativePath !== "string"
    ) {
      throw new BadRequestException("Invalid multipart relative path");
    }
    if (
      !Number.isSafeInteger(fileSize) ||
      (fileSize as number) <= 0 ||
      !Number.isSafeInteger(chunkSize) ||
      (chunkSize as number) < S3_MIN_MULTIPART_PART_BYTES ||
      (chunkSize as number) > maxChunkBytes ||
      !Number.isSafeInteger(initialChunkSize) ||
      (initialChunkSize as number) < S3_MIN_MULTIPART_PART_BYTES ||
      (initialChunkSize as number) > (chunkSize as number) ||
      (fileSize as number) <= (initialChunkSize as number) ||
      !Number.isSafeInteger(totalChunks) ||
      (totalChunks as number) < 2 ||
      (totalChunks as number) > 10_000
    ) {
      throw new BadRequestException("Invalid multipart layout");
    }

    const expectedTotalChunks =
      1 +
      Math.ceil(
        ((fileSize as number) - (initialChunkSize as number)) /
          (chunkSize as number),
      );
    if (totalChunks !== expectedTotalChunks) {
      throw new BadRequestException("Invalid multipart part count");
    }

    let parsedEncryptionChunkSize: number | undefined;
    if (encryptionChunkSize !== undefined && encryptionChunkSize !== null) {
      if (
        !Number.isSafeInteger(encryptionChunkSize) ||
        (encryptionChunkSize as number) < 1_000_000 ||
        (encryptionChunkSize as number) > (chunkSize as number) ||
        (chunkSize as number) % (encryptionChunkSize as number) !== 0 ||
        (initialChunkSize as number) % (encryptionChunkSize as number) !== 0
      ) {
        throw new BadRequestException("Invalid multipart encryption layout");
      }
      parsedEncryptionChunkSize = encryptionChunkSize as number;
    }

    return {
      id,
      name,
      relativePath: typeof relativePath === "string" ? relativePath : undefined,
      totalChunks: totalChunks as number,
      fileSize: fileSize as number,
      chunkSize: chunkSize as number,
      initialChunkSize: initialChunkSize as number,
      encryptionChunkSize: parsedEncryptionChunkSize,
    };
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
    declaredChunkSize?: number,
    encryptionChunkSize?: number,
  ): number {
    if (!contentLength || !/^\d+$/.test(contentLength)) {
      throw new BadRequestException(
        "A valid Content-Length header is required for streaming uploads",
      );
    }

    const parsed = Number(contentLength);
    const maxPayloadBytes = getMaxUploadPayloadBytes(
      maxChunkBytes,
      declaredChunkSize,
      encryptionChunkSize,
    );
    if (!Number.isSafeInteger(parsed) || parsed > maxPayloadBytes) {
      throw new PayloadTooLargeException(
        `Upload chunk exceeds the ${maxChunkBytes}-byte limit`,
      );
    }
    return parsed;
  }

  private assertChunkBodySize(
    body: Buffer | undefined,
    maxChunkBytes: number,
    declaredChunkSize?: number,
    encryptionChunkSize?: number,
  ) {
    if (!Buffer.isBuffer(body)) {
      throw new BadRequestException("Missing upload chunk body");
    }
    const maxPayloadBytes = getMaxUploadPayloadBytes(
      maxChunkBytes,
      declaredChunkSize,
      encryptionChunkSize,
    );
    if (body.length > maxPayloadBytes) {
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
  @Throttle({ default: { limit: 5, ttl: minutes(1) } })
  @UseGuards(FileSecurityGuard)
  async getZip(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("shareId", SafeIdPipe) shareId: string,
  ) {
    const zipStream = await this.fileService.getZip(shareId);

    // Zip = always a real download -> trigger notification
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
    });
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
          this.prisma.teamAccessLog
            .create({
              data: {
                teamId: folder.teamId,
                action: "DOWNLOAD",
                actorEmail: downloader?.email || "anonymous",
                actorName: downloader?.username || undefined,
                fileName: `${shareId}.zip`,
                folderId: share.teamFolderId,
              },
            })
            .catch((err) =>
              this.logger.error(`Failed to log DOWNLOAD (zip): ${err.message}`),
            );
        }
      }
    }

    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(`${shareId}.zip`),
      "Cache-Control":
        "private, no-cache, no-store, must-revalidate, no-transform",
      Pragma: "no-cache",
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
    @Headers("x-download-resume") downloadResume?: string,
  ) {
    const authorizedShare = (
      req as Request & {
        authorizedShare?: Share;
      }
    ).authorizedShare;

    // Read trusted metadata before opening any local/S3 object stream. This
    // lets us validate Range and return 416 without issuing a wasteful full
    // GetObject that would immediately be destroyed.
    const fileMetaData = await this.prisma.file.findFirst({
      where: { id: fileId, shareId },
      select: {
        name: true,
        size: true,
        encryptionChunkSize: true,
      },
    });
    if (!fileMetaData) throw new NotFoundException("File not found");

    const fileSize = Number(fileMetaData.size);
    if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
      throw new InternalServerErrorException("Invalid stored file size");
    }

    const rangeHeader = req.headers.range;
    const range = rangeHeader
      ? parseSingleByteRange(rangeHeader, fileSize)
      : undefined;
    if (rangeHeader && !range) {
      res.status(416).set({
        "Content-Range": `bytes */${fileSize}`,
        "Accept-Ranges": "bytes",
      });
      res.end();
      return;
    }

    const detectedMime =
      mime?.lookup?.(fileMetaData.name) || "application/octet-stream";

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
    const isResumeRequest =
      downloadResume === "1" && !!range && range.start > 0;

    // For attachment downloads use application/octet-stream so that
    // intermediary proxies / WAFs (SafeLine, nginx gzip) do not try to
    // inspect, buffer, or compress the response body.  The browser uses
    // the filename from Content-Disposition, not Content-Type.
    const contentType = forceDownload
      ? "application/octet-stream"
      : detectedMime;

    // Open exactly one object stream, already scoped to the requested range.
    const file = await this.fileService.get(
      shareId,
      fileId,
      range,
      authorizedShare?.storageProvider,
    );

    // Only trigger download notification for actual downloads, not previews.
    if (forceDownload && authorizedShare && !isResumeRequest) {
      this.recordFileDownload(
        req,
        authorizedShare,
        fileMetaData.name,
        fileMetaData.size,
      );
    }

    if (range) {
      const disposition = forceDownload
        ? contentDisposition(fileMetaData.name)
        : contentDisposition(fileMetaData.name, { type: "inline" });

      const rangeHeaders: Record<string, any> = {
        "Content-Type": forceDownload
          ? "application/octet-stream"
          : contentType,
        "Content-Range": `bytes ${range.start}-${range.end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": range.end - range.start + 1,
        "Content-Disposition": disposition,
        "Cache-Control":
          "private, no-cache, no-store, must-revalidate, no-transform",
        Pragma: "no-cache",
        "X-Accel-Buffering": "no",
      };
      // CSP sandbox only for inline preview (document context).
      // Setting it on fetch() responses causes WebKit to abort the stream.
      if (!forceDownload) {
        rangeHeaders["Content-Security-Policy"] = "sandbox";
      }
      if (fileMetaData.encryptionChunkSize) {
        rangeHeaders["X-Encryption-Chunk-Size"] =
          fileMetaData.encryptionChunkSize;
      }
      res.status(206).set(rangeHeaders);

      return new StreamableFile(file.file);
    }

    // --- Full response ---
    const headers: Record<string, any> = {
      "Content-Type": contentType,
      "Content-Length": fileSize,
      "Accept-Ranges": "bytes",
      "Cache-Control":
        "private, no-cache, no-store, must-revalidate, no-transform",
      Pragma: "no-cache",
      "X-Accel-Buffering": "no",
    };

    // CSP sandbox only for inline preview (document context).
    // Setting it on fetch() responses causes WebKit to abort the stream.
    if (!forceDownload) {
      headers["Content-Security-Policy"] = "sandbox";
    }
    if (fileMetaData.encryptionChunkSize) {
      headers["X-Encryption-Chunk-Size"] = fileMetaData.encryptionChunkSize;
    }

    if (forceDownload) {
      headers["Content-Disposition"] = contentDisposition(fileMetaData.name);
    } else {
      headers["Content-Disposition"] = contentDisposition(fileMetaData.name, {
        type: "inline",
      });
    }

    res.set(headers);

    return new StreamableFile(file.file);
  }

  @Get(":fileId/direct")
  @Throttle({ default: { limit: 1_000, ttl: hours(1) } })
  @UseGuards(FileSecurityGuard)
  async authorizeDirectDownload(
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
    const authorization = await this.fileService.authorizeBrowserDownload(
      shareId,
      fileId,
      authorizedShare?.storageProvider,
      download === "true",
    );
    res.set({
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
    });
    if (
      authorization.direct &&
      authorization.forceDownload &&
      authorizedShare
    ) {
      this.recordFileDownload(
        req,
        authorizedShare,
        authorization.fileName,
        String(authorization.size),
      );
    }
    return authorization;
  }

  private recordFileDownload(
    req: Request,
    share: Share,
    fileName: string,
    fileSize: string,
  ): void {
    const isRegistered = !!(req as unknown as { user?: User }).user;
    void this.downloadNotificationService
      .onDownload(share, isRegistered)
      .catch((err) =>
        this.logger.error(`Failed to record download: ${err.message}`),
      );

    // Audit I/O must not delay authorization or the first response byte.
    if (share.teamFolderId) {
      void (async () => {
        const folder = await this.prisma.teamFolder.findUnique({
          where: { id: share.teamFolderId! },
          select: { teamId: true },
        });
        if (folder) {
          const downloader = (req as unknown as { user?: User }).user;
          await this.prisma.teamAccessLog.create({
            data: {
              teamId: folder.teamId,
              action: "DOWNLOAD",
              actorEmail: downloader?.email || "anonymous",
              actorName: downloader?.username || undefined,
              fileName,
              fileSize: BigInt(fileSize),
              folderId: share.teamFolderId,
            },
          });
        }
      })().catch((err) =>
        this.logger.error(`Failed to log DOWNLOAD: ${err.message}`),
      );
    }
  }

  @Delete(":fileId")
  @Throttle({ default: { limit: 50, ttl: minutes(1) } })
  @UseGuards(ShareOwnerGuard)
  async remove(
    @Param("fileId", SafeIdPipe) fileId: string,
    @Param("shareId", SafeIdPipe) shareId: string,
  ) {
    // Log team activity before deletion
    const share = await this.prisma.share.findUnique({
      where: { id: shareId },
    });
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
        this.prisma.teamAccessLog
          .create({
            data: {
              teamId: folder.teamId,
              action: "FILE_DELETE",
              actorEmail: share.creatorId || "unknown",
              fileName: file.name,
              fileSize: file.size ? BigInt(file.size) : undefined,
              folderId: share.teamFolderId,
            },
          })
          .catch((err) =>
            this.logger.error(`Failed to log FILE_DELETE: ${err.message}`),
          );

        // Notify team members about the deletion
        if (share.creatorId) {
          this.teamNotificationService
            .notifyTeamMembers(
              folder.teamId,
              share.creatorId,
              "FILE_DELETED",
              `Un fichier "${file.name}" a été supprimé`,
              { folderId: share.teamFolderId! },
            )
            .catch((err) =>
              this.logger.error(
                `Failed to notify team on file delete: ${err.message}`,
              ),
            );
        }
      }
    }

    await this.fileService.remove(shareId, fileId);
  }

  @Put(":fileId/reencrypt")
  @Throttle({ default: { limit: 10_000, ttl: hours(1) } })
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
    const maxReencryptPayloadBytes = getMaxUploadPayloadBytes(
      MAX_UPLOAD_CHUNK_BYTES,
      MAX_UPLOAD_CHUNK_BYTES,
      encryptionChunkSize,
    );
    if (body.length > maxReencryptPayloadBytes) {
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
