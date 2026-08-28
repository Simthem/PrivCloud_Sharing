import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { EmailVerificationService } from "./emailVerification.service";
import { buildEmailVerificationMessage } from "../email/email.service";

const HOUR_MS = 60 * 60 * 1000;

void (async () => {
  let persisted: Record<string, unknown> | undefined;
  let deliveredToken = "";
  let deletedHashes: string[] | undefined;
  let storedTokens: { tokenHash: string; expiresAt: Date; createdAt: Date }[] =
    [];
  let lookedUpUser: unknown;
  const deliveries: string[] = [];

  const prisma = {
    emailVerificationToken: {
      findMany: async () => storedTokens,
      deleteMany: async ({ where }: { where: any }) => {
        deletedHashes = where?.tokenHash?.in;
        return { count: deletedHashes?.length ?? 0 };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        persisted = data;
        return data;
      },
    },
    user: {
      findFirst: async () => lookedUpUser,
    },
    $transaction: async (operations: Promise<unknown>[]) =>
      Promise.all(operations),
  };
  const config = {
    get: (key: string) => (key === "smtp.enabled" ? true : undefined),
  };
  const email = {
    sendEmailVerificationEmail: async (recipient: string, token: string) => {
      deliveries.push(recipient);
      deliveredToken = token;
    },
  };
  const service = new EmailVerificationService(
    prisma as never,
    config as never,
    email as never,
  );

  const unverifiedUser = {
    id: "user-1",
    email: "new@example.test",
    emailVerificationRequiredAt: new Date(),
    emailVerifiedAt: null,
    emailVerificationDeletionStartedAt: null,
  };

  // A token is delivered in the clear and stored only as a digest.
  await service.issueAndSend(unverifiedUser);

  assert.equal(deliveries.at(-1), "new@example.test");
  assert.equal(deliveredToken.length, 43);
  assert.match(deliveredToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    persisted?.tokenHash,
    crypto.createHash("sha256").update(deliveredToken).digest("hex"),
  );
  assert.notEqual(persisted?.tokenHash, deliveredToken);
  assert.equal(persisted?.email, "new@example.test");
  assert.equal(persisted?.userId, "user-1");
  assert.deepEqual(deletedHashes, []);

  // A resend must not revoke the links already travelling towards the inbox:
  // only expired tokens and the oldest ones beyond the cap are dropped.
  const now = Date.now();
  storedTokens = [
    { tokenHash: "live-1", createdAt: new Date(now - 1000), expiresAt: new Date(now + HOUR_MS) },
    { tokenHash: "live-2", createdAt: new Date(now - 2000), expiresAt: new Date(now + HOUR_MS) },
    { tokenHash: "live-3", createdAt: new Date(now - 3000), expiresAt: new Date(now + HOUR_MS) },
    { tokenHash: "expired-1", createdAt: new Date(now - 4000), expiresAt: new Date(now - HOUR_MS) },
  ];
  deletedHashes = undefined;
  await service.issueAndSend(unverifiedUser);

  assert.deepEqual(deletedHashes?.sort(), ["expired-1", "live-3"]);
  storedTokens = [];

  // The public cooldown is per requested address and identical for an address
  // that has no account, so the response cannot be used to enumerate users.
  lookedUpUser = null;
  const unknownFirst = await service.resend("stranger@example.test");
  const unknownSecond = await service.resend("STRANGER@example.test");

  assert.equal(unknownFirst.accepted, true);
  assert.equal(unknownFirst.retryAfterSeconds, 60);
  assert.equal(unknownSecond.accepted, false);
  assert(unknownSecond.retryAfterSeconds > 0);
  assert(unknownSecond.retryAfterSeconds <= 60);

  // A real account gets the same shape, and a second attempt is refused rather
  // than silently acknowledged: the caller now knows nothing was sent.
  const deliveriesBefore = deliveries.length;
  lookedUpUser = { ...unverifiedUser, emailVerificationTokens: [] };
  const accountFirst = await service.resend("new@example.test");
  const accountSecond = await service.resend("new@example.test");

  assert.equal(accountFirst.accepted, true);
  assert.equal(accountSecond.accepted, false);
  assert.equal(deliveries.length, deliveriesBefore + 1);

  // Backstop for the replica that did not serve the previous request and for
  // the link issued at sign-up seconds earlier.
  lookedUpUser = {
    ...unverifiedUser,
    emailVerificationTokens: [{ createdAt: new Date() }],
  };
  const justIssued = await service.resend("fresh@example.test");
  assert.equal(justIssued.accepted, true);
  assert.equal(deliveries.length, deliveriesBefore + 1);

  const message = buildEmailVerificationMessage(
    "PrivCloud",
    "https://share.example.test/auth/verify-email#token=secret",
  );
  assert.equal(message.includes("\\n"), false);
  assert.match(message, /Welcome to PrivCloud\.\n\nVerify your email/);
  assert.match(message, /#token=secret\n\nThe link expires/);

  console.log("19 email verification token, resend and message tests passed");
})();
