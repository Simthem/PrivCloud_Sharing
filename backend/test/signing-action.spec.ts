import "reflect-metadata";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { HEADERS_METADATA } from "@nestjs/common/constants";
import { SigningController } from "src/signing/signing.controller";
import {
  toSigningAction,
  isRecipientViewer,
} from "src/signing/signing-exposure.util";
import { SigningService } from "src/signing/signing.service";
import { sealToken } from "src/config/account-secrets";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("signing account actions");
const token = randomUUID();
const otherToken = randomUUID();
const viewer = {
  userId: "signer",
  email: "signer@example.test",
  isRequester: false,
};
const stored = (value: string) => sealToken("signing", value);
const recipient = (
  id = "own",
  userId: string | null = "signer",
  order = 1,
) => ({
  id,
  userId,
  order,
  email: `${userId ?? "signer"}@example.test`,
  name: id,
  role: "SIGNER",
  status: "PENDING",
  signedAt: null,
  signingToken: stored(id === "own" ? token : otherToken),
  wrappedE2EKey: randomBytes(24).toString("base64url"),
});
const document = () => ({
  id: "document",
  creatorId: "requester",
  status: "PENDING",
  fileId: "source",
  fileDeletedAt: null as Date | null,
  expiresAt: new Date(Date.now() + 60_000),
  isE2EEncrypted: false,
  shareId: null,
  teamId: null,
  recipients: [recipient(), recipient("other", "other")],
  fields: [],
  auditTrail: [],
});

testCase(
  "returns only the current signer's link, including a provider-bound address",
  () => {
    const doc = document();
    doc.recipients[0].email = "alias@provider.example";
    assert.deepEqual(toSigningAction(doc, viewer), {
      recipientId: "own",
      path: `/sign/${token}`,
      wrappedE2EKey: doc.recipients[0].wrappedE2EKey,
    });
    assert.equal(
      toSigningAction(doc, { userId: "requester", isRequester: true }),
      null,
    );
    assert.equal(
      toSigningAction(doc, { userId: "team-admin", isRequester: false }),
      null,
    );
  },
);

testCase(
  "requires a verified address for an unbound invitation and respects existing account binding",
  () => {
    const doc = document();
    doc.recipients[0].userId = null;
    doc.recipients[0].email = "Signer@Example.test";
    assert.equal(toSigningAction(doc, { ...viewer, email: null }), null);
    assert.equal(toSigningAction(doc, viewer)?.recipientId, "own");
    doc.recipients[0].userId = "different-account";
    assert.equal(toSigningAction(doc, viewer), null);
    assert.equal(isRecipientViewer(doc.recipients[0], viewer), false);
  },
);

testCase(
  "does not offer signing for terminal requests, expired deadlines or deleted files",
  () => {
    for (const status of [
      "COMPLETED",
      "CANCELLED",
      "REJECTED",
      "AWAITING_FINALIZATION",
      "SIGNING_FAILED",
    ]) {
      assert.equal(
        toSigningAction({ ...document(), status }, viewer),
        null,
        status,
      );
    }
    assert.equal(
      toSigningAction({ ...document(), expiresAt: new Date(0) }, viewer),
      null,
    );
    assert.equal(
      toSigningAction({ ...document(), fileId: null }, viewer),
      null,
    );
    assert.equal(
      toSigningAction({ ...document(), fileDeletedAt: new Date() }, viewer),
      null,
    );
  },
);

testCase(
  "only offers a pending signer whose turn has arrived, including parallel signing",
  () => {
    for (const status of ["SIGNED", "REJECTED"]) {
      const doc = document();
      doc.recipients[0].status = status;
      assert.equal(toSigningAction(doc, viewer), null);
    }
    for (const role of ["CC", "APPROVER"]) {
      const doc = document();
      doc.recipients[0].role = role;
      assert.equal(toSigningAction(doc, viewer), null);
    }
    const doc = document();
    doc.recipients[0].order = 2;
    assert.equal(toSigningAction(doc, viewer), null);
    doc.recipients[1].status = "SIGNED";
    doc.status = "PARTIAL";
    doc.recipients[0].status = "VIEWED";
    assert.equal(toSigningAction(doc, viewer)?.recipientId, "own");
    doc.recipients[1].status = "PENDING";
    doc.recipients[0].order = 1;
    assert.equal(toSigningAction(doc, viewer)?.recipientId, "own");
  },
);

function serviceHarness() {
  const doc = document();
  const service = new SigningService(
    {
      user: {
        findUnique: async () => ({
          email: viewer.email,
          emailVerifiedAt: new Date(),
        }),
      },
      signatureDocument: {
        findMany: async () => [doc],
        findFirst: async ({ where }: Prisma.SignatureDocumentFindFirstArgs) =>
          where?.creatorId && where.creatorId !== doc.creatorId ? null : doc,
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { doc, service };
}

testCase(
  "the received API labels the right recipient and strips every other secret",
  async () => {
    const { service, doc } = serviceHarness();
    const [result] = await service.getReceivedDocuments(viewer.userId);
    assert.equal(result.isRequester, false);
    assert.equal(result.signingAction?.path, `/sign/${token}`);
    assert.equal(result.recipients[0].isCurrentUser, true);
    assert.equal(result.recipients[1].isCurrentUser, false);
    for (const row of result.recipients) {
      assert.equal("signingToken" in row, false);
      assert.equal("wrappedE2EKey" in row, false);
      assert.equal("userId" in row, false);
    }
    assert.equal(JSON.stringify(result).includes(otherToken), false);
    assert.equal(
      JSON.stringify(result).includes(doc.recipients[1].wrappedE2EKey),
      false,
    );
  },
);

testCase(
  "detail distinguishes the requester and signer without exposing another invitation",
  async () => {
    const { service, doc } = serviceHarness();
    const result = await service.getDocument(doc.id, viewer.userId);
    assert.equal(result.isRequester, false);
    assert.equal(result.signingAction?.path, `/sign/${token}`);
    assert.equal(JSON.stringify(result).includes(otherToken), false);
    const owner = await service.getDocument(doc.id, doc.creatorId);
    assert.equal(owner.isRequester, true);
    assert.equal(owner.signingAction, null);
    assert.equal(owner.recipients[1].signingToken, otherToken);
  },
);

testCase(
  "a recipient cannot cancel or send reminders through the server",
  async () => {
    const { service, doc } = serviceHarness();
    await assert.rejects(
      service.cancelDocument(doc.id, viewer.userId),
      /Document not found/,
    );
    await assert.rejects(
      service.sendReminder(doc.id, viewer.userId),
      /Document not found/,
    );
  },
);

testCase(
  "private invitation responses cannot be stored in an HTTP cache",
  () => {
    for (const method of ["getReceivedDocuments", "getDocument"] as const) {
      const headers: { name: string; value: string }[] = Reflect.getMetadata(
        HEADERS_METADATA,
        SigningController.prototype[method],
      );
      assert.ok(
        headers.some(
          ({ name, value }) =>
            name === "Cache-Control" && value === "private, no-store",
        ),
      );
    }
  },
);

void run();
