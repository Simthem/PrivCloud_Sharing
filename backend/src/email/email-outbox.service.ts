import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { EmailOutbox, Prisma } from "@prisma/client";
import * as crypto from "crypto";
import { ConfigService } from "src/config/config.service";
import { PrismaService } from "src/prisma/prisma.service";
import { EmailService } from "./email.service";
import {
  decryptOutboxEmail,
  encryptOutboxEmail,
  OutboxEmail,
} from "./email-outbox.crypto";

const CLAIM_TIMEOUT_MS = 5 * 60 * 1000;
const SENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 10;

@Injectable()
export class EmailOutboxService {
  private readonly logger = new Logger(EmailOutboxService.name);
  private delivering = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly emailService: EmailService,
  ) {}

  async enqueue(
    client: Pick<Prisma.TransactionClient, "emailOutbox">,
    message: OutboxEmail,
    deduplicationKey: string,
  ): Promise<string> {
    const key = crypto
      .createHash("sha256")
      .update(deduplicationKey, "utf8")
      .digest("hex");
    const id = crypto.randomUUID();
    const row = await client.emailOutbox.upsert({
      where: { deduplicationKey: key },
      create: {
        id,
        deduplicationKey: key,
        encryptedPayload: encryptOutboxEmail(message, this.secret(), key),
      },
      update: {},
      select: { id: true },
    });
    return row.id;
  }

  /** Best-effort immediate delivery; the interval remains the durable retry. */
  async deliverPending(): Promise<void> {
    if (this.delivering) return;
    this.delivering = true;
    try {
      for (const row of await this.claimBatch()) {
        await this.deliver(row);
      }
      await this.prisma.emailOutbox.deleteMany({
        where: {
          sentAt: { lt: new Date(Date.now() - SENT_RETENTION_MS) },
        },
      });
    } finally {
      this.delivering = false;
    }
  }

  @Interval(5_000)
  async scheduledDelivery(): Promise<void> {
    await this.deliverPending();
  }

  private async claimBatch(): Promise<EmailOutbox[]> {
    const now = new Date();
    const stale = new Date(now.getTime() - CLAIM_TIMEOUT_MS);
    return this.prisma.$transaction(async (tx) => {
      const candidates = await tx.emailOutbox.findMany({
        where: {
          sentAt: null,
          availableAt: { lte: now },
          OR: [{ claimedAt: null }, { claimedAt: { lt: stale } }],
        },
        orderBy: { createdAt: "asc" },
        take: BATCH_SIZE,
        select: { id: true },
      });

      const claimed: EmailOutbox[] = [];
      for (const { id } of candidates) {
        const won = await tx.emailOutbox.updateMany({
          where: {
            id,
            sentAt: null,
            availableAt: { lte: now },
            OR: [{ claimedAt: null }, { claimedAt: { lt: stale } }],
          },
          data: {
            claimedAt: now,
            attempts: { increment: 1 },
          },
        });
        if (won.count !== 1) continue;
        const row = await tx.emailOutbox.findUnique({ where: { id } });
        if (row) claimed.push(row);
      }
      return claimed;
    });
  }

  private async deliver(row: EmailOutbox): Promise<void> {
    try {
      const message = decryptOutboxEmail(
        row.encryptedPayload,
        this.secret(),
        row.deduplicationKey,
      );
      await this.emailService.sendMail(
        message.recipient,
        message.subject,
        message.text,
        { messageId: `<${row.id}@privcloud-outbox.local>` },
      );
      await this.prisma.emailOutbox.updateMany({
        where: { id: row.id, claimedAt: row.claimedAt, sentAt: null },
        data: { sentAt: new Date(), claimedAt: null, lastError: null },
      });
    } catch {
      const retryDelay = Math.min(
        60 * 60 * 1000,
        5_000 * 2 ** Math.min(row.attempts, 9),
      );
      await this.prisma.emailOutbox.updateMany({
        where: { id: row.id, claimedAt: row.claimedAt, sentAt: null },
        data: {
          claimedAt: null,
          availableAt: new Date(Date.now() + retryDelay),
          lastError: "Email delivery failed",
        },
      });
      this.logger.warn("Queued email delivery failed; retry scheduled");
    }
  }

  private secret(): string {
    const secret =
      this.config.get("internal.jwtSecret") || process.env.JWT_SECRET;
    if (!secret) throw new Error("JWT secret is required for the email outbox");
    return secret;
  }
}
