import "reflect-metadata";
import assert from "node:assert/strict";
import { SigningE2EService } from "src/signing/signing-e2e.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("signing E2E notifications");

testCase(
  "notifies active internal recipients after the requester finalizes the PDF",
  async () => {
    const notifications: Array<Record<string, unknown>> = [];
    let stored = false;
    let completed = false;
    const recipients = [
      {
        id: "recipient-a",
        userId: "member-a",
        role: "SIGNER",
        status: "SIGNED",
        email: "a@example.com",
        teamCompletionNotification: "encrypted-a",
      },
      {
        id: "recipient-b",
        userId: "inactive-member",
        role: "SIGNER",
        status: "SIGNED",
        email: "b@example.com",
        teamCompletionNotification: "encrypted-b",
      },
    ];
    const service = new SigningE2EService(
      {
        signatureDocument: {
          findFirst: async () => ({
            id: "document-1",
            creatorId: "creator-1",
            fileId: "file-1",
            fileName: "contract.pdf",
            isE2EEncrypted: true,
            status: "AWAITING_FINALIZATION",
            teamId: "team-1",
            recipients,
          }),
          update: async ({ data }: any) => {
            completed = data.status === "COMPLETED";
          },
        },
        signatureAuditEvent: {
          findFirst: async () => ({ id: "pades-event" }),
        },
        signatureRecipient: { findMany: async () => recipients },
        teamMember: { findMany: async () => [{ userId: "member-a" }] },
        teamAccessLog: { create: async () => ({}) },
        user: { findUnique: async () => null },
      } as never,
      { sendMail: async () => undefined } as never,
      { storeFileByKey: async () => (stored = true) } as never,
      { get: () => "https://example.invalid" } as never,
      {} as never,
      {
        notify: async (params: Record<string, unknown>) => {
          notifications.push(params);
        },
      } as never,
    ) as any;
    service.createAuditEvent = async () => undefined;

    const result = await service.storeE2EFinal(
      "document-1",
      "creator-1",
      Buffer.from("encrypted-pdf"),
    );

    assert.equal(stored, true);
    assert.equal(completed, true);
    assert.deepEqual(result, { status: "COMPLETED" });
    assert.deepEqual(
      notifications.map((notification) => ({
        type: notification.type,
        userId: notification.userId,
        actorId: notification.actorId,
        encryptedMetadata: notification.encryptedMetadata,
      })),
      [
        {
          type: "SIGNATURE_COMPLETED",
          userId: "member-a",
          actorId: "creator-1",
          encryptedMetadata: "encrypted-a",
        },
      ],
    );
  },
);

void run();
