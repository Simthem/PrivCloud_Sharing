import assert from "node:assert/strict";
import { JobsService } from "src/jobs/jobs.service";

void (async () => {
  const events: string[] = [];
  let lookupWhere: any;
  let claimStartedAt: Date | undefined;
  const service: any = Object.create(JobsService.prototype);
  service.logger = { log: () => {}, warn: () => {} };
  service.runExclusive = async (_name: string, job: () => Promise<void>) =>
    job();
  let smtpEnabled = true;
  service.config = { get: (key: string) => (key === "smtp.enabled" ? smtpEnabled : undefined) };
  service.fileService = {
    deleteAllFiles: async (shareId: string) => {
      assert.equal(shareId, "share-1");
      events.push("files");
    },
  };
  service.prisma = {
    user: {
      findMany: async ({ where }: { where: any }) => {
        lookupWhere = where;
        return [
          {
            id: "new-unverified-user",
            emailVerificationDeletionStartedAt: null,
            shares: [{ id: "share-1" }],
          },
        ];
      },
      updateMany: async ({ data }: { data: any }) => {
        claimStartedAt = data.emailVerificationDeletionStartedAt;
        return { count: 1 };
      },
      deleteMany: async ({ where }: { where: any }) => {
        assert.equal(where.id, "new-unverified-user");
        assert.equal(
          where.emailVerificationDeletionStartedAt,
          claimStartedAt,
        );
        events.push("database");
        return { count: 1 };
      },
    },
  };

  const before = Date.now();
  await service.deleteExpiredUnverifiedAccounts();
  const after = Date.now();

  assert.equal(lookupWhere.emailVerifiedAt, null);
  assert(lookupWhere.emailVerificationRequiredAt.lte instanceof Date);
  const cutoff = lookupWhere.emailVerificationRequiredAt.lte.getTime();
  assert(cutoff >= before - 14 * 24 * 60 * 60 * 1000 - 10);
  assert(cutoff <= after - 14 * 24 * 60 * 60 * 1000 + 10);
  assert.deepEqual(events, ["files", "database"]);

  // Deleting accounts on an instance that cannot send a verification link
  // would destroy data its users had no way to save.
  smtpEnabled = false;
  events.length = 0;
  await service.deleteExpiredUnverifiedAccounts();
  assert.deepEqual(events, []);

  console.log("6 expired unverified account cleanup tests passed");
})();

