import assert from "node:assert/strict";
import { EmailVerificationService } from "src/emailVerification/emailVerification.service";
import { JobsService } from "src/jobs/jobs.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("team member verification");

type Member = {
  id: string;
  email: string;
  emailVerificationRequiredAt: Date | null;
  emailVerifiedAt: Date | null;
  emailVerificationDeletionStartedAt: Date | null;
  teamVerificationMailedAt: Date | null;
  liveToken: boolean;
};

function service(members: Member[], smtp = true) {
  const issued: { id: string; withoutDeadline: boolean }[] = [];
  let findWhere: Record<string, unknown> | undefined;
  const svc = Object.create(
    EmailVerificationService.prototype,
  ) as EmailVerificationService;
  Object.assign(svc, {
    logger: { log: () => undefined, warn: () => undefined },
    config: { get: (key: string) => ({ "smtp.enabled": smtp })[key] },
    emailOutbox: { deliverPending: async () => undefined },
    issueInTransaction: async (
      _tx: unknown,
      user: { id: string },
      withoutDeadline: boolean,
    ) => {
      issued.push({ id: user.id, withoutDeadline });
    },
    prisma: {
      $transaction: async (work: (tx: unknown) => unknown) => work({}),
      user: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          findWhere = where;
          return members
            .filter((member) => !member.teamVerificationMailedAt)
            .map(({ liveToken, ...member }) => ({
              ...member,
              emailVerificationTokens: liveToken ? [{ tokenHash: "h" }] : [],
            }));
        },
        updateMany: async ({ where }: { where: { id: string } }) => {
          const member = members.find((item) => item.id === where.id)!;
          if (member.teamVerificationMailedAt) return { count: 0 };
          member.teamVerificationMailedAt = new Date();
          return { count: 1 };
        },
      },
    },
  });
  return { svc, issued, findWhere: () => findWhere };
}

const member = (id: string, extra: Partial<Member> = {}): Member => ({
  id,
  email: `${id}@example.test`,
  emailVerificationRequiredAt: null,
  emailVerifiedAt: null,
  emailVerificationDeletionStartedAt: null,
  teamVerificationMailedAt: null,
  liveToken: false,
  ...extra,
});

testCase(
  "each unverified member receives one link, without a deadline",
  async () => {
    const members = [member("a"), member("b")];
    const { svc, issued, findWhere } = service(members);
    assert.equal(await svc.mailTeamMembers(), 2);
    assert.deepEqual(issued, [
      { id: "a", withoutDeadline: true },
      { id: "b", withoutDeadline: true },
    ]);
    assert.deepEqual(findWhere(), {
      emailVerifiedAt: null,
      emailVerificationDeletionStartedAt: null,
      teamVerificationMailedAt: null,
      OR: [
        { teamMemberships: { some: { isActive: true } } },
        {
          emailVerificationRequiredAt: null,
          password: null,
          oAuthUsers: { some: {} },
        },
      ],
    });
    assert.equal(await svc.mailTeamMembers(), 0);
    assert.equal(issued.length, 2);
  },
);

testCase(
  "a member with a valid link is marked but not mailed again",
  async () => {
    const members = [member("fresh", { liveToken: true })];
    const { svc, issued } = service(members);
    assert.equal(await svc.mailTeamMembers(), 0);
    assert.equal(issued.length, 0);
    assert.ok(members[0].teamVerificationMailedAt);
  },
);

testCase("without SMTP nothing is marked, the next run mails", async () => {
  const members = [member("later")];
  const off = service(members, false);
  assert.equal(await off.svc.mailTeamMembers(), 0);
  assert.equal(members[0].teamVerificationMailedAt, null);
  const on = service(members);
  assert.equal(await on.svc.mailTeamMembers(), 1);
});

testCase("a new provider account gets its link once, at sign-up", async () => {
  const members = [member("sso")];
  const { svc, issued } = service(members);
  Object.assign((svc as unknown as { prisma: { user: object } }).prisma.user, {
    findUnique: async () => ({ ...members[0] }),
  });
  await svc.inviteWithoutDeadline("sso");
  await svc.inviteWithoutDeadline("sso");
  assert.deepEqual(issued, [{ id: "sso", withoutDeadline: true }]);
  assert.equal(await svc.mailTeamMembers(), 0);
});

testCase("the deletion job never selects a team member", async () => {
  const wheres: Record<string, unknown>[] = [];
  const jobs = Object.create(JobsService.prototype) as JobsService;
  Object.assign(jobs, {
    logger: { log: () => undefined, warn: () => undefined },
    runExclusive: async (_name: string, job: () => Promise<void>) => job(),
    config: { get: (key: string) => ({ "smtp.enabled": true })[key] },
    prisma: {
      user: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          wheres.push(where);
          return [];
        },
      },
    },
  });
  await jobs.deleteExpiredUnverifiedAccounts();
  assert.deepEqual(wheres[0].teamMemberships, {
    none: { isActive: true },
  });
});

void run();
