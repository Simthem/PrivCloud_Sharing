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
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  UploadPartCommandOutput,
} from "@aws-sdk/client-s3";
import { PrismaService } from "src/prisma/prisma.service";
import { ConfigService } from "src/config/config.service";
import * as crypto from "crypto";
import * as mime from "mime-types";
import { File } from "./file.service";
import { Readable, PassThrough } from "stream";
import { validate as isValidUUID } from "uuid";
import archiver from "archiver";

@Injectable()
export class S3FileService {
  private readonly logger = new Logger(S3FileService.name);

  private multipartUploads: Record<
    string,
    {
      uploadId: string;
      parts: Array<{ ETag: string | undefined; PartNumber: number }>;
      lastActivity: number;
      shareId: string;
    }
  > = {};

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

  // --- Global S3 upload concurrency limiter ---
  // Each in-flight UploadPart holds a full chunk buffer in RAM.
  // With parallel chunk upload, multiple users can have multiple parts
  // in transit simultaneously.  Cap total to bound peak memory usage
  // Defaults to 4 slots; lower S3_MAX_CONCURRENT_UPLOADS on small VMs.
  private static readonly MAX_S3_CONCURRENT = Math.max(
    1,
    parseInt(process.env.S3_MAX_CONCURRENT_UPLOADS || "4", 10) || 4,
  );
  private s3ActiveUploads = 0;
  private readonly s3UploadQueue: Array<{
    resolve: (acquired: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private async acquireUploadSlot(timeoutMs = 60_000): Promise<boolean> {
    if (this.s3ActiveUploads < S3FileService.MAX_S3_CONCURRENT) {
      this.s3ActiveUploads++;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.s3UploadQueue.findIndex((e) => e.resolve === resolve);
        if (idx >= 0) this.s3UploadQueue.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
      this.s3UploadQueue.push({ resolve, timer });
    });
  }

  private releaseUploadSlot(): void {
    if (this.s3UploadQueue.length > 0) {
      const next = this.s3UploadQueue.shift()!;
      clearTimeout(next.timer);
      // Transfer slot to the next waiter (s3ActiveUploads count stays same)
      next.resolve(true);
    } else {
      this.s3ActiveUploads--;
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
    if (error.name === "NoSuchUpload" || error.Code === "NoSuchUpload") return true;
    // HTTP 404 from S3 on multipart operations usually means the upload is gone
    if (error.$metadata?.httpStatusCode === 404) return true;
    // Fallback: check the message string
    if (typeof error.message === "string" && error.message.includes("NoSuchUpload")) return true;
    return false;
  }

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {
    // Periodically clean up abandoned multipart upload sessions
    setInterval(() => this.cleanupAbandonedUploads(), 5 * 60 * 1000);
  }

  /**
   * Abort in-memory multipart upload sessions that have been inactive
   * for longer than MULTIPART_TTL_MS.  Sends AbortMultipartUploadCommand
   * to S3/MinIO so the uploaded parts are actually freed on the bucket.
   */
  private async cleanupAbandonedUploads() {
    const now = Date.now();
    for (const [key, upload] of Object.entries(this.multipartUploads)) {
      if (now - upload.lastActivity > S3FileService.MULTIPART_TTL_MS) {
        this.logger.warn(
          `Cleaning up abandoned multipart upload: key=${key} uploadId=${upload.uploadId}`,
        );
        // Actually abort the multipart upload on S3 so parts are freed
        try {
          const s3Instance = this.getS3Instance();
          // We need to figure out the bucket + key.  The in-memory key
          // format is either a fileId (upload) or "reencrypt:<fileId>".
          // We don't store the full S3 key, so we use
          // ListMultipartUploads filtered by UploadId is not possible --
          // but we can abort by UploadId + any matching key.  Since
          // AbortMultipartUpload only needs Bucket + Key + UploadId and
          // we store the UploadId, we need to reconstruct the key.
          // Unfortunately we don't store shareId here.  Best-effort:
          // use the S3-side ListMultipartUploads to find the matching
          // upload and abort it.
          const bucket = this.config.get("s3.bucketName");
          const prefix = this.getS3Path();
          const listResp = await s3Instance.send(
            new ListMultipartUploadsCommand({
              Bucket: bucket,
              Prefix: prefix,
            }),
          );
          const match = listResp.Uploads?.find(
            (u) => u.UploadId === upload.uploadId,
          );
          if (match && match.Key) {
            await s3Instance.send(
              new AbortMultipartUploadCommand({
                Bucket: bucket,
                Key: match.Key,
                UploadId: upload.uploadId,
              }),
            );
            this.logger.log(
              `Aborted S3 multipart upload: key=${match.Key} uploadId=${upload.uploadId}`,
            );
          }
        } catch (abortErr) {
          this.logger.error(
            `Failed to abort S3 multipart upload: uploadId=${upload.uploadId} error=${abortErr}`,
          );
        }
        delete this.multipartUploads[key];
      }
    }
  }

  /**
   * Abort all in-memory multipart uploads for a given share.
   * Called when a share is deleted or an upload is cancelled.
   */
  async abortShareMultipartUploads(shareId: string) {
    const s3Instance = this.getS3Instance();
    const bucket = this.config.get("s3.bucketName");

    for (const [key, upload] of Object.entries(this.multipartUploads)) {
      if (upload.shareId === shareId) {
        delete this.multipartUploads[key];
      }
    }

    // Abort all S3-side multipart uploads under this share's prefix
    const prefix = `${this.getS3Path()}${shareId}/`;
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
  async cleanupStaleS3Multiparts(maxAgeMs: number = 2 * 60 * 60 * 1000) {
    const s3Instance = this.getS3Instance();
    const bucket = this.config.get("s3.bucketName");
    const prefix = this.getS3Path();
    const cutoff = new Date(Date.now() - maxAgeMs);
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

  async create(
    data: Buffer,
    chunk: { index: number; total: number },
    file: { id?: string; name: string },
    shareId: string,
    _clientChunkSize?: number,
    _share?: any,
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
    // data is already a Buffer from Express raw body parser.
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "base64");
    // Use fileId as the S3 object key -- never the user-supplied filename.
    // This prevents overwrites when two files share the same name and
    // eliminates path-traversal risks from crafted filenames.
    const key = `${this.getS3Path()}${shareId}/${file.id}`;
    const bucketName = this.config.get("s3.bucketName");
    const s3Instance = this.getS3Instance();

    let allPartsComplete = false;

    try {
      // Initialize multipart upload if it's the first chunk
      if (chunk.index === 0) {
        const multipartInitResponse = await s3Instance.send(
          new CreateMultipartUploadCommand({
            Bucket: bucketName,
            Key: key,
          }),
        );

        const uploadId = multipartInitResponse.UploadId;
        if (!uploadId) {
          throw new Error("Failed to initialize multipart upload.");
        }

        // Store the uploadId and parts list in memory
        this.multipartUploads[file.id] = {
          uploadId,
          parts: [],
          lastActivity: Date.now(),
          shareId,
        };
      }

      // Get the ongoing multipart upload
      const multipartUpload = this.multipartUploads[file.id];
      if (!multipartUpload) {
        throw new InternalServerErrorException(
          "Multipart upload session not found.",
        );
      }

      // Refresh activity timestamp so the cleanup job never kills
      // a long-running but actively-uploading session.
      multipartUpload.lastActivity = Date.now();

      const uploadId = multipartUpload.uploadId;

      // Upload the current chunk (bounded by global concurrency semaphore).
      // Each in-flight UploadPart holds a full chunk buffer (~200 MB).
      const partNumber = chunk.index + 1; // Part numbers start from 1

      const acquired = await this.acquireUploadSlot();
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
            UploadId: uploadId,
            Body: buffer,
          }),
        );
      } finally {
        this.releaseUploadSlot();
      }

      // Store the ETag and PartNumber for later completion.
      // Deduplicate: if a chunk was retried after a network failure that
      // occurred *after* the backend had already pushed the part (e.g.
      // Caddy 502 while writing the response back), the same PartNumber
      // would be recorded twice.  Without dedup, parts.length would reach
      // chunk.total prematurely with missing unique parts → corrupted file.
      const existingIdx = multipartUpload.parts.findIndex(
        (p) => p.PartNumber === partNumber,
      );
      if (existingIdx >= 0) {
        multipartUpload.parts[existingIdx] = {
          ETag: uploadPartResponse.ETag,
          PartNumber: partNumber,
        };
      } else {
        multipartUpload.parts.push({
          ETag: uploadPartResponse.ETag,
          PartNumber: partNumber,
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
          delete this.multipartUploads[file.id];
          allPartsComplete = true;
        } catch (completeError) {
          // Complete failed: the upload state on S3 is uncertain.
          // Abort the session to free S3 resources and signal the client
          // to restart from chunk 0.  Do NOT return 503 here – retrying
          // the last chunk after Complete could create a duplicate if the
          // first Complete actually succeeded (response lost in transit).
          try {
            await s3Instance.send(
              new AbortMultipartUploadCommand({
                Bucket: bucketName,
                Key: key,
                UploadId: uploadId,
              }),
            );
          } catch { /* ignore abort error on already-completed upload */ }
          delete this.multipartUploads[file.id];
          this.logger.error(
            `S3 complete failed: fileId=${file.id} chunk=${chunk.index}/${chunk.total}: ${(completeError as any)?.message}`,
            completeError instanceof Error ? completeError.stack : completeError,
          );
          throw new InternalServerErrorException(
            "Multipart upload completion failed.",
          );
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
        delete this.multipartUploads[file.id];
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

      await this.prisma.file.create({
        data: {
          id: file.id,
          name: file.name,
          size: fileSize.toString(),
          share: { connect: { id: shareId } },
        },
      });
      this.logger.debug(
        `File uploaded: shareId=${shareId} fileId=${file.id} fileName="${file.name}" size=${fileSize} mimeType=${mime.contentType(file.name.split(".").pop() ?? "") || false}`,
      );
    }

    return file;
  }

  /**
   * Replace the content of an existing file (re-encryption).
   * Same multipart upload flow as create() but overwrites the existing
   * S3 object and does NOT create a DB record.
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

    const buffer = Buffer.from(data, "base64");
    const key = `${this.getS3Path()}${shareId}/${fileId}`;
    const bucketName = this.config.get("s3.bucketName");
    const s3Instance = this.getS3Instance();
    const reencryptKey = `reencrypt:${fileId}`;

    try {
      if (chunk.index === 0) {
        const multipartInitResponse = await s3Instance.send(
          new CreateMultipartUploadCommand({ Bucket: bucketName, Key: key }),
        );
        const uploadId = multipartInitResponse.UploadId;
        if (!uploadId) throw new Error("Failed to initialize multipart upload.");
        this.multipartUploads[reencryptKey] = { uploadId, parts: [], lastActivity: Date.now(), shareId };
      }

      const multipartUpload = this.multipartUploads[reencryptKey];
      if (!multipartUpload) {
        throw new InternalServerErrorException("Multipart upload session not found.");
      }

      multipartUpload.lastActivity = Date.now();

      const partNumber = chunk.index + 1;
      const uploadPartResponse = await s3Instance.send(
        new UploadPartCommand({
          Bucket: bucketName,
          Key: key,
          PartNumber: partNumber,
          UploadId: multipartUpload.uploadId,
          Body: buffer,
        }),
      );

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
        };
      } else {
        multipartUpload.parts.push({
          ETag: uploadPartResponse.ETag,
          PartNumber: partNumber,
        });
      }

      if (chunk.index === chunk.total - 1) {
        await s3Instance.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucketName,
            Key: key,
            UploadId: multipartUpload.uploadId,
            MultipartUpload: { Parts: multipartUpload.parts },
          }),
        );
        delete this.multipartUploads[reencryptKey];

        const fileSize = await this.getFileSize(shareId, fileId);
        await this.prisma.file.update({
          where: { id: fileId },
          data: { size: fileSize.toString() },
        });
        this.logger.debug(
          `File re-encrypted: shareId=${shareId} fileId=${fileId} size=${fileSize}`,
        );
      }
    } catch (error) {
      const multipartUpload = this.multipartUploads[reencryptKey];
      if (multipartUpload) {
        try {
          await s3Instance.send(
            new AbortMultipartUploadCommand({
              Bucket: bucketName,
              Key: key,
              UploadId: multipartUpload.uploadId,
            }),
          );
        } catch (abortError) {
          this.logger.error(
            `Error aborting multipart upload: shareId=${shareId} fileId=${fileId}`,
            abortError instanceof Error ? abortError.stack : abortError,
          );
        }
        delete this.multipartUploads[reencryptKey];
      }
      this.logger.error(
        `S3 re-encryption failed: shareId=${shareId} fileId=${fileId} chunk=${chunk.index}/${chunk.total}`,
        error instanceof Error ? error.stack : error,
      );
      throw new Error("Multipart re-encryption upload failed.");
    }
  }

  async get(
    shareId: string,
    fileId: string,
    range?: { start: number; end: number },
  ): Promise<File> {
    const fileRecord = await this.prisma.file.findUnique({ where: { id: fileId } });
    if (!fileRecord) throw new NotFoundException("File not found");
    const fileName = fileRecord.name;

    const s3Instance = this.getS3Instance();
    const key = `${this.getS3Path()}${shareId}/${fileId}`;
    const response = await s3Instance.send(
      new GetObjectCommand({
        Bucket: this.config.get("s3.bucketName"),
        Key: key,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }),
    );

    const mimeType =
      mime.contentType(fileId.split(".").pop()) || "application/octet-stream";
    const size = response.ContentLength?.toString() || "0";
    this.logger.debug(
      `File downloaded: shareId=${shareId} fileId=${fileId} fileName="${fileName}" size=${size} mimeType=${mimeType}`,
    );

    // Pipe S3 body through a PassThrough with a large highWaterMark
    // (1 MB) so Node.js pre-fetches data from MinIO aggressively
    // instead of using the default 16 KB watermark.  This reduces the
    // number of read() calls by ~64x and keeps the downstream proxy
    // chain (Caddy / Nginx) fed with data continuously.
    const bodyStream = response.Body as Readable;
    const fast = new PassThrough({ highWaterMark: 1024 * 1024 });
    bodyStream.pipe(fast);

    return {
      metaData: {
        id: fileId,
        size,
        name: fileName,
        shareId: shareId,
        createdAt: response.LastModified || new Date(),
        mimeType,
      },
      file: fast,
    } as File;
  }

  async remove(shareId: string, fileId: string) {
    const fileMetaData = await this.prisma.file.findUnique({
      where: { id: fileId },
    });

    if (!fileMetaData) throw new NotFoundException("File not found");

    const key = `${this.getS3Path()}${shareId}/${fileId}`;
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
    const prefix = `${this.getS3Path()}${shareId}/`;
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
    const key = `${this.getS3Path()}${shareId}/${fileId}`;
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
    const checksumCalculation =
      this.config.get("s3.useChecksum") === true ? null : "WHEN_REQUIRED";

    // Proxy support: global-agent (loaded via NODE_OPTIONS) patches
    // http.request() / https.request() at the module level.
    // AWS SDK v3 NodeHttpHandler calls these patched functions internally,
    // so HTTP_PROXY / HTTPS_PROXY env vars are honored automatically.
    return new S3Client({
      endpoint: this.config.get("s3.endpoint"),
      region: this.config.get("s3.region"),
      credentials: {
        accessKeyId: this.config.get("s3.key"),
        secretAccessKey: this.config.get("s3.secret"),
      },
      forcePathStyle: true,
      requestChecksumCalculation: checksumCalculation,
      responseChecksumValidation: checksumCalculation,
    });
  }

  async getZip(shareId: string): Promise<Readable> {
    const s3Instance = this.getS3Instance();
    const bucketName = this.config.get("s3.bucketName");
    const compressionLevel = this.config.get("share.zipCompressionLevel");

    const prefix = `${this.getS3Path()}${shareId}/`;

    const listResponse = await s3Instance.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
      }),
    );

    if (!listResponse.Contents || listResponse.Contents.length === 0) {
      throw new NotFoundException(`No files found for share ${shareId}`);
    }

    const archive = archiver("zip", {
      zlib: { level: parseInt(compressionLevel) },
    });

    archive.on("error", (err) => {
      this.logger.error("Archive error", err);
    });

    const fileKeys = listResponse.Contents.filter(
      (object) => object.Key && object.Key !== prefix,
    ).map((object) => object.Key as string);

    if (fileKeys.length === 0) {
      throw new NotFoundException(
        `No valid files found for share ${shareId}`,
      );
    }

    const processNextFile = async (index: number) => {
      if (index >= fileKeys.length) {
        archive.finalize();
        return;
      }

      const key = fileKeys[index];
      const fileName = key.replace(prefix, "");

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
  async putRawObject(rawKey: string, data: Buffer, contentType = "application/pdf"): Promise<void> {
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
