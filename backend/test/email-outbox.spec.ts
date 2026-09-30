import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import {
  decryptOutboxEmail,
  encryptOutboxEmail,
} from "src/email/email-outbox.crypto";
import { EmailOutboxService } from "src/email/email-outbox.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("email outbox encryption");

testCase(
  "encrypts email payloads with authenticated randomized envelopes",
  () => {
    const message = {
      recipient: "recipient@example.test",
      subject: "A private subject",
      text: "A secret token and temporary password",
    };
    const secret = crypto.randomBytes(32).toString("base64url");
    const unrelatedSecret = crypto.randomBytes(32).toString("base64url");
    const associatedKey = "deduplication-key";
    const first = encryptOutboxEmail(message, secret, associatedKey);
    const second = encryptOutboxEmail(message, secret, associatedKey);

    assert.notEqual(first, second);
    assert.equal(first.includes(message.recipient), false);
    assert.equal(first.includes(message.subject), false);
    assert.equal(first.includes(message.text), false);
    assert.deepEqual(decryptOutboxEmail(first, secret, associatedKey), message);
    assert.throws(() =>
      decryptOutboxEmail(first, unrelatedSecret, associatedKey),
    );
    assert.throws(() =>
      decryptOutboxEmail(first, secret, "wrong-associated-key"),
    );

    const parts = first.split(".");
    parts[2] = `${parts[2].startsWith("A") ? "B" : "A"}${parts[2].slice(1)}`;
    assert.throws(() =>
      decryptOutboxEmail(parts.join("."), secret, associatedKey),
    );
  },
);

testCase(
  "claims an encrypted message only once across two replicas",
  async () => {
    type Row = {
      id: string;
      deduplicationKey: string;
      encryptedPayload: string;
      createdAt: Date;
      availableAt: Date;
      claimedAt: Date | null;
      sentAt: Date | null;
      attempts: number;
      lastError: string | null;
    };
    const rows = new Map<string, Row>();
    let transactionTail = Promise.resolve();
    const emailOutbox = {
      upsert: async ({ where, create }: any) => {
        const existing = [...rows.values()].find(
          (row) => row.deduplicationKey === where.deduplicationKey,
        );
        if (existing) return { id: existing.id };
        const now = new Date();
        rows.set(create.id, {
          ...create,
          createdAt: now,
          availableAt: now,
          claimedAt: null,
          sentAt: null,
          attempts: 0,
          lastError: null,
        });
        return { id: create.id };
      },
      findMany: async ({ where, take }: any) =>
        [...rows.values()]
          .filter(
            (row) =>
              !row.sentAt &&
              row.availableAt <= where.availableAt.lte &&
              (!row.claimedAt || row.claimedAt < where.OR[1].claimedAt.lt),
          )
          .slice(0, take)
          .map(({ id }) => ({ id })),
      updateMany: async ({ where, data }: any) => {
        const row = rows.get(where.id);
        if (!row || row.sentAt) return { count: 0 };
        if (data.attempts) {
          const staleBefore = where.OR[1].claimedAt.lt as Date;
          if (row.claimedAt && row.claimedAt >= staleBefore)
            return { count: 0 };
          row.claimedAt = data.claimedAt;
          row.attempts += 1;
        } else {
          if (row.claimedAt?.getTime() !== where.claimedAt?.getTime()) {
            return { count: 0 };
          }
          Object.assign(row, data);
        }
        return { count: 1 };
      },
      findUnique: async ({ where }: any) => rows.get(where.id) ?? null,
      deleteMany: async () => ({ count: 0 }),
    };
    const prisma: any = {
      emailOutbox,
      $transaction: async (operation: (client: any) => Promise<unknown>) => {
        let release!: () => void;
        const previous = transactionTail;
        transactionTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await operation(prisma);
        } finally {
          release();
        }
      },
    };
    const deliveries: Array<{ recipient: string; messageId?: string }> = [];
    const email = {
      sendMail: async (
        recipient: string,
        _subject: string,
        _text: string,
        options: { messageId?: string },
      ) => {
        deliveries.push({ recipient, messageId: options.messageId });
      },
    };
    const config = {
      get: (name: string) =>
        name === "internal.jwtSecret" ? "outbox-test-secret" : undefined,
    };
    const firstReplica = new EmailOutboxService(
      prisma,
      config as never,
      email as never,
    );
    const secondReplica = new EmailOutboxService(
      prisma,
      config as never,
      email as never,
    );
    const message = {
      recipient: "recipient@example.test",
      subject: "Atomic invitation",
      text: "secret invitation token",
    };

    const id = await firstReplica.enqueue(
      prisma,
      message,
      "team-invitation:invitation-1",
    );
    const stored = rows.get(id);
    assert(stored);
    assert.equal(stored.encryptedPayload.includes(message.recipient), false);
    assert.equal(stored.encryptedPayload.includes(message.text), false);

    await Promise.all([
      firstReplica.deliverPending(),
      secondReplica.deliverPending(),
    ]);

    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].recipient, message.recipient);
    assert.equal(deliveries[0].messageId, `<${id}@privcloud-outbox.local>`);
    assert.equal(rows.get(id)?.attempts, 1);
    assert(rows.get(id)?.sentAt instanceof Date);
  },
);

void run();
