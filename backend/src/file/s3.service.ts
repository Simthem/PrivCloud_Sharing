import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Logger,
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
    }
  > = {};

  // TTL for abandoned multipart uploads: no chunk received for 30 min.
  // This is an *inactivity* timeout, not a total duration limit, so
  // multi-hour uploads of very large files (40 GB+) are safe as long
  // as chunks keep arriving.
  private static readonly MULTIPART_TTL_MS = 30 * 60 * 1000;

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

  async create(
    data: string,
    chunk: { index: number; total: number },
    file: { id?: string; name: string },
    shareId: string,
    _clientChunkSize?: number,
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

    const buffer = Buffer.from(data, "base64");
    // Use fileId as the S3 object key -- never the user-supplied filename.
    // This prevents overwrites when two files share the same name and
    // eliminates path-traversal risks from crafted filenames.
    const key = `${this.getS3Path()}${shareId}/${file.id}`;
    const bucketName = this.config.get("s3.bucketName");
    const s3Instance = this.getS3Instance();

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

      // Upload the current chunk
      const partNumber = chunk.index + 1; // Part numbers start from 1

      const uploadPartResponse: UploadPartCommandOutput = await s3Instance.send(
        new UploadPartCommand({
          Bucket: bucketName,
          Key: key,
          PartNumber: partNumber,
          UploadId: uploadId,
          Body: buffer,
        }),
      );

      // Store the ETag and PartNumber for later completion
      multipartUpload.parts.push({
        ETag: uploadPartResponse.ETag,
        PartNumber: partNumber,
      });

      // Complete the multipart upload if it's the last chunk
      if (chunk.index === chunk.total - 1) {
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
      }
    } catch (error) {
      // Abort the multipart upload if it fails
      const multipartUpload = this.multipartUploads[file.id];
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
          console.error("Error aborting multipart upload:", abortError);
        }
        delete this.multipartUploads[file.id];
      }
      this.logger.error(error);
      throw new Error("Multipart upload failed. The upload has been aborted.");
    }

    const isLastChunk = chunk.index == chunk.total - 1;
    if (isLastChunk) {
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
        this.multipartUploads[reencryptKey] = { uploadId, parts: [], lastActivity: Date.now() };
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

      multipartUpload.parts.push({
        ETag: uploadPartResponse.ETag,
        PartNumber: partNumber,
      });

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
          console.error("Error aborting multipart upload:", abortError);
        }
        delete this.multipartUploads[reencryptKey];
      }
      this.logger.error(error);
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
    const commandInput: any = {
      Bucket: this.config.get("s3.bucketName"),
      Key: key,
    };
    if (range) {
      commandInput.Range = `bytes=${range.start}-${range.end}`;
    }
    const response = await s3Instance.send(
      new GetObjectCommand(commandInput),
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
    const s3Instance = this.getS3Instance();
    const bucketName = this.config.get("s3.bucketName");

    // Abort any in-progress multipart uploads for this share
    try {
      const listUploads = await s3Instance.send(
        new ListMultipartUploadsCommand({ Bucket: bucketName, Prefix: prefix }),
      );
      for (const upload of listUploads.Uploads || []) {
        if (upload.UploadId && upload.Key) {
          await s3Instance.send(
            new AbortMultipartUploadCommand({
              Bucket: bucketName,
              Key: upload.Key,
              UploadId: upload.UploadId,
            }),
          );
          this.logger.debug(
            `Aborted multipart upload: key=${upload.Key} uploadId=${upload.UploadId}`,
          );
        }
      }
    } catch (e) {
      this.logger.warn(`Failed to list/abort multipart uploads for share ${shareId}: ${(e as Error).message}`);
    }

    try {
      // Paginate: ListObjectsV2 returns max 1000 objects per call
      let continuationToken: string | undefined;
      do {
        const listResponse = await s3Instance.send(
          new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );

        if (!listResponse.Contents || listResponse.Contents.length === 0) {
          if (!continuationToken) {
            this.logger.warn(`No files found in S3 for share ${shareId} - skipping deletion`);
          }
          break;
        }

        const objectsToDelete = listResponse.Contents.map((file) => ({
          Key: file.Key!,
        }));

        await s3Instance.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: objectsToDelete },
          }),
        );

        continuationToken = listResponse.IsTruncated
          ? listResponse.NextContinuationToken
          : undefined;
      } while (continuationToken);
    } catch (error) {
      this.logger.error(error);
      throw new Error("Could not delete all files from S3");
    }
  }

  async getFileSize(shareId: string, fileName: string): Promise<number> {
    const key = `${this.getS3Path()}${shareId}/${fileName}`;
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
   * Abort multipart uploads that S3/MinIO still tracks but that the
   * application no longer references (e.g. after a crash or timeout).
   */
  async cleanupStaleS3Multiparts() {
    const s3Instance = this.getS3Instance();
    const bucketName = this.config.get("s3.bucketName");
    try {
      const listUploads = await s3Instance.send(
        new ListMultipartUploadsCommand({ Bucket: bucketName }),
      );
      for (const upload of listUploads.Uploads || []) {
        if (upload.UploadId && upload.Key) {
          const ageMs =
            Date.now() - (upload.Initiated?.getTime() ?? Date.now());
          // Only abort uploads older than 1 hour
          if (ageMs > 60 * 60 * 1000) {
            await s3Instance.send(
              new AbortMultipartUploadCommand({
                Bucket: bucketName,
                Key: upload.Key,
                UploadId: upload.UploadId,
              }),
            );
            this.logger.log(
              `Aborted stale S3 multipart upload: key=${upload.Key} uploadId=${upload.UploadId} age=${Math.round(ageMs / 60000)}min`,
            );
          }
        }
      }
    } catch (e) {
      this.logger.error(
        `Failed to cleanup stale S3 multipart uploads: ${(e as Error).message}`,
      );
    }
  }
}
