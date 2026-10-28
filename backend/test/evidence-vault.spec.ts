import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "crypto";
import { HttpException } from "@nestjs/common";
import { EvidenceVaultGuard } from "src/evidenceVault/evidenceVault.guard";
import {
  EVIDENCE_VAULT_COOKIE,
  EvidenceVaultService,
} from "src/evidenceVault/evidenceVault.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("evidence vault");

const admin = { id: randomUUID(), email: "admin@example.test", isAdmin: true };
const other = { id: randomUUID(), email: "other@example.test", isAdmin: true };
const TEAM = randomUUID();
const ISSUANCE = randomUUID();
const PREVIEW = randomUUID();

type Session = {
  sessionHash: string;
  userId: string;
  expiresAt: Date;
};

function vault(
  options: {
    teamExists?: boolean;
    verify?: () => Promise<void>;
  } = {},
) {
  const sessions: Session[] = [];
  const calls: string[] = [];
  const manifest = JSON.stringify({ team: { id: TEAM, name: "Cabinet" } });
  const prisma = {
    evidenceVaultSession: {
      deleteMany: async (args: {
        where: { userId?: string; OR?: { userId?: string }[] };
      }) => {
        const userId = args.where.userId ?? args.where.OR?.[0]?.userId;
        for (let i = sessions.length - 1; i >= 0; i--) {
          if (sessions[i].userId === userId) sessions.splice(i, 1);
        }
        return { count: 0 };
      },
      create: async (args: { data: Session }) => {
        sessions.push(args.data);
        return args.data;
      },
      findUnique: async (args: { where: { sessionHash: string } }) =>
        sessions.find((row) => row.sessionHash === args.where.sessionHash) ??
        null,
    },
    teamExternalIssuance: {
      findFirst: async (args: { where: { id: string; teamId: string } }) =>
        args.where.id === ISSUANCE && args.where.teamId === TEAM
          ? { previewId: PREVIEW }
          : null,
      groupBy: async (args: { _max?: object }) =>
        args._max
          ? [{ teamId: TEAM, _max: { issuedAt: new Date() } }]
          : [{ teamId: TEAM, _count: { _all: 3 } }],
      findMany: async () => [{ teamId: TEAM, manifest }],
    },
    team: {
      findUnique: async () => (options.teamExists ? { id: TEAM } : null),
      findMany: async () =>
        options.teamExists ? [{ id: TEAM, name: "Cabinet renommé" }] : [],
    },
  };
  const audit = {
    appendEvent: async (event: { kind: string; previewId: string }) => {
      calls.push(`event:${event.kind}:${event.previewId}`);
    },
    certificateOf: async () => {
      calls.push("certificate");
      return Buffer.from("%PDF-");
    },
    eraseTeam: async () => {
      calls.push("erase");
      return { issuances: 3, events: 9, anchors: 2 };
    },
  };
  const passkeys = {
    verifyVault: options.verify ?? (async () => undefined),
  };
  const service = new EvidenceVaultService(
    prisma as never,
    passkeys as never,
    audit as never,
  );
  Object.assign(service, {
    logger: { warn: () => undefined, log: () => undefined },
  });
  return { service, sessions, calls };
}

const answer = { challengeId: randomUUID(), response: {} };

testCase(
  "the vault opens for one administrator, a few minutes, once",
  async () => {
    const { service, sessions } = vault();
    const first = await service.unlock(admin as never, answer);
    // Only the SHA-256 of the cookie value is stored.
    assert.match(first.value, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(sessions.length, 1);
    assert.equal(
      sessions[0].sessionHash,
      createHash("sha256").update(first.value).digest("hex"),
    );
    assert.ok(first.expiresAt.getTime() - Date.now() <= 10 * 60 * 1000);
    assert.ok(await service.openUntil(first.value, admin as never));
    // Another administrator cannot use it, a malformed value never matches.
    assert.equal(await service.openUntil(first.value, other as never), null);
    assert.equal(await service.openUntil("x".repeat(43), admin as never), null);
    assert.equal(await service.openUntil(undefined, admin as never), null);
    // Opening again replaces the earlier opening.
    const second = await service.unlock(admin as never, answer);
    assert.equal(sessions.length, 1);
    assert.equal(await service.openUntil(first.value, admin as never), null);
    assert.ok(await service.openUntil(second.value, admin as never));
    // Expired.
    sessions[0].expiresAt = new Date(Date.now() - 1);
    assert.equal(await service.openUntil(second.value, admin as never), null);
    await service.lock(admin as never);
    assert.equal(sessions.length, 0);
  },
);

testCase("a refused passkey leaves the vault shut", async () => {
  const { service, sessions } = vault({
    verify: async () => {
      throw new Error("invalid");
    },
  });
  await assert.rejects(service.unlock(admin as never, answer));
  assert.equal(sessions.length, 0);
});

testCase("the guard wants an administrator and an opened vault", async () => {
  const { service } = vault();
  const guard = new EvidenceVaultGuard(service);
  const context = (user: object | undefined, cookie?: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          user,
          cookies: cookie ? { [EVIDENCE_VAULT_COOKIE]: cookie } : {},
        }),
      }),
    }) as never;
  const { value } = await service.unlock(admin as never, answer);
  assert.equal(await guard.canActivate(context(admin, value)), true);
  for (const denied of [
    context(admin),
    context(other, value),
    context({ ...admin, isAdmin: false }, value),
    context(undefined, value),
    context(admin, randomBytes(32).toString("base64url")),
  ]) {
    await assert.rejects(guard.canActivate(denied), (error: HttpException) => {
      assert.equal(error.getStatus(), 403);
      return true;
    });
  }
});

testCase("every extraction is journaled before it is returned", async () => {
  const { service, calls } = vault();
  const pdf = await service.certificate(TEAM, ISSUANCE, admin as never);
  assert.equal(pdf.toString(), "%PDF-");
  assert.deepEqual(calls, [`event:VAULT:${PREVIEW}`, "certificate"]);
  await assert.rejects(
    service.certificate(TEAM, randomUUID(), admin as never),
    (error: HttpException) => error.getStatus() === 404,
  );
  assert.equal(calls.length, 2);
});

testCase("teams keep their recorded name once deleted", async () => {
  let { service } = vault();
  assert.deepEqual(
    (await service.teams()).map(({ teamName, teamExists, copies }) => ({
      teamName,
      teamExists,
      copies,
    })),
    [{ teamName: "Cabinet", teamExists: false, copies: 3 }],
  );
  ({ service } = vault({ teamExists: true }));
  const [team] = await service.teams("cabinet");
  assert.equal(team.teamName, "Cabinet renommé");
  assert.equal(team.teamExists, true);
  await assert.rejects(
    service.teams("x".repeat(101)),
    (error: HttpException) => error.getStatus() === 400,
  );
});

testCase(
  "evidence is erased early only for a deleted team, by its exact name",
  async () => {
    let { service, calls } = vault({ teamExists: true });
    await assert.rejects(
      service.erase(TEAM, "Cabinet renommé", admin as never),
      (error: HttpException) => error.getStatus() === 409,
    );
    assert.deepEqual(calls, []);
    ({ service, calls } = vault());
    await assert.rejects(
      service.erase(TEAM, "cabinet", admin as never),
      (error: HttpException) => error.getStatus() === 400,
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(await service.erase(TEAM, "Cabinet", admin as never), {
      issuances: 3,
      events: 9,
      anchors: 2,
    });
    assert.deepEqual(calls, ["erase"]);
  },
);

void run();
