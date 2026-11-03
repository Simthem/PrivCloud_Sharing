import { Prisma } from "@prisma/client";

/** The share an upload goes to, as FileService reads it once per chunk. */
export type UploadShare = Prisma.ShareGetPayload<{
  include: {
    files: { select: { size: true } };
    reverseShare: true;
  };
}>;
