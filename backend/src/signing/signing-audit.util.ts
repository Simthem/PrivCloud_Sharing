import * as crypto from "crypto";
import { PrismaService } from "src/prisma/prisma.service";

const AUDIT_CHAIN_PROTOCOL = "privcloud-signing-audit-v1";
const documentQueues = new Map<string, Promise<void>>();

export type SignatureAuditInput = {
  documentId: string;
  eventType: string;
  actor: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: string | Record<string, unknown>;
};

/**
 * Appends a tamper-evident event to a per-document hash chain.
 *
 * SQLite already serializes writers. The small per-document queue also keeps
 * concurrent appends in this process ordered before the transaction reads the
 * previous hash. The chain detects later modification; it is not a qualified
 * preservation or timestamping service.
 */
export async function appendSignatureAuditEvent(
  prisma: PrismaService,
  input: SignatureAuditInput,
) {
  const previousQueue =
    documentQueues.get(input.documentId) || Promise.resolve();
  let releaseQueue!: () => void;
  const queue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const tail = previousQueue.then(() => queue);
  documentQueues.set(input.documentId, tail);

  await previousQueue;
  try {
    return await prisma.$transaction(async (tx) => {
      const previous = await tx.signatureAuditEvent.findFirst({
        where: { documentId: input.documentId, eventHash: { not: null } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { eventHash: true },
      });
      const id = crypto.randomUUID();
      const createdAt = new Date();
      const metadata =
        typeof input.metadata === "string"
          ? input.metadata
          : input.metadata
            ? JSON.stringify(input.metadata)
            : null;
      const previousEventHash = previous?.eventHash || null;
      const canonicalEvent = JSON.stringify({
        protocol: AUDIT_CHAIN_PROTOCOL,
        id,
        documentId: input.documentId,
        eventType: input.eventType,
        actor: input.actor,
        ipAddress: input.ipAddress || null,
        userAgent: input.userAgent || null,
        metadata,
        createdAt: createdAt.toISOString(),
        previousEventHash,
      });
      const eventHash = crypto
        .createHash("sha256")
        .update(canonicalEvent)
        .digest("hex");

      return tx.signatureAuditEvent.create({
        data: {
          id,
          documentId: input.documentId,
          eventType: input.eventType,
          actor: input.actor,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          metadata,
          createdAt,
          previousEventHash,
          eventHash,
        },
      });
    });
  } finally {
    releaseQueue();
    if (documentQueues.get(input.documentId) === tail) {
      documentQueues.delete(input.documentId);
    }
  }
}
