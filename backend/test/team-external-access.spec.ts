import "reflect-metadata";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { AuthenticatedUserGuard } from "src/auth/guard/authenticatedUser.guard";
import { AccessGrantService } from "src/crypto/grant.service";
import { TeamService } from "src/team/team.service";
import {
  TeamExternalAdminController,
  TeamExternalContractorController,
} from "src/teamExternal/team-external.controller";
import { TeamExternalService } from "src/teamExternal/team-external.service";
import {
  displayedSeatStatus,
  EXTERNAL_WRAPPING_ALGORITHM,
  EXTERNAL_PAGE_MAX_BYTES,
  externalPreviewPageKey,
  hashExternalToken,
  isSeatUsable,
  isValidHybridWrapping,
  parseAccessExpiry,
  seatTakesPlace,
} from "src/teamExternal/team-external.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("team external access");

const NOW = new Date("2026-10-06T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const TEAM = "11111111-1111-4111-8111-111111111111";
const PREVIEW = "22222222-2222-4222-8222-222222222222";
const SEAT = "33333333-3333-4333-8333-333333333333";

const b64 = (bytes: number) => "A".repeat(Math.ceil((bytes * 4) / 3));
const wrapping = () => ({
  encryptedKey: b64(48),
  ephemeralPublicKey: b64(32),
  nonce: b64(12),
  kemCiphertext: b64(1088),
  algorithm: EXTERNAL_WRAPPING_ALGORITHM,
});

const contractor = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "contractor",
    email: "presta@example.test",
    username: "presta",
    totpVerified: true,
    ...overrides,
  }) as never;

const admin = { id: "admin", email: "admin@example.test", username: "admin" };

async function rejects(promise: Promise<unknown>, status: number) {
  await assert.rejects(promise, (error: { getStatus?: () => number }) => {
    assert.equal(error.getStatus?.(), status);
    return true;
  });
}

type JournalEvent = { kind: string; pageIndex?: number | null };

function auditStub(events: JournalEvent[] = []) {
  return {
    appendEvent: async (event: JournalEvent) => void events.push(event),
    appendEventInTransaction: async (_tx: unknown, event: JournalEvent) =>
      void events.push(event),
    finalizeIssuance: async () => "issuance",
    timestampIssuance: async () => undefined,
  };
}

function service(
  prisma: Record<string, unknown>,
  files: object = {},
  audit: object = auditStub(),
) {
  const cipher = Buffer.from("cipher");
  const cipherHash = createHash("sha256").update(cipher).digest("hex");
  const external = new TeamExternalService(
    {
      teamExternalPreviewPage: {
        findUnique: async () => ({ sha256: cipherHash, size: cipher.length }),
      },
      teamExternalIssuance: {
        findUnique: async () => ({
          status: "ISSUED",
          manifest: JSON.stringify({
            accessExpiresAt: new Date(Date.now() + DAY).toISOString(),
            copy: {
              pages: [
                { cipherSha256: cipherHash },
                { cipherSha256: cipherHash },
              ],
            },
          }),
        }),
      },
      ...prisma,
      $transaction:
        prisma.$transaction ??
        (async (work: (tx: object) => unknown) =>
          work({
            ...prisma,
            $executeRaw: async () => 1,
          })),
    } as never,
    {
      get: (key: string) =>
        key === "general.appUrl" ? "https://app" : "PrivCloud",
    } as never,
    files as never,
    {
      enqueue: async () => "id",
      deliverPending: async () => undefined,
    } as never,
    audit as never,
  );
  Object.assign(external, {
    logger: {
      warn: () => undefined,
      debug: () => undefined,
      log: () => undefined,
    },
  });
  return external;
}

const adminMembership = {
  teamMember: { findFirst: async () => ({ id: "member" }) },
};

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

testCase(
  "only accepted, unexpired seats bound to an account are usable",
  () => {
    const seat = {
      status: "ACTIVE",
      userId: "u",
      inviteExpiresAt: new Date(NOW.getTime() + DAY),
      accessExpiresAt: new Date(NOW.getTime() + DAY),
    };
    assert.equal(isSeatUsable(seat, NOW), true);
    assert.equal(isSeatUsable({ ...seat, userId: null }, NOW), false);
    assert.equal(isSeatUsable({ ...seat, status: "PENDING" }, NOW), false);
    assert.equal(isSeatUsable({ ...seat, status: "REVOKED" }, NOW), false);
    assert.equal(isSeatUsable({ ...seat, accessExpiresAt: NOW }, NOW), false);
    assert.equal(
      displayedSeatStatus({ ...seat, accessExpiresAt: NOW }, NOW),
      "EXPIRED",
    );
    assert.equal(seatTakesPlace({ ...seat, status: "REVOKED" }, NOW), false);
    assert.equal(
      seatTakesPlace({ ...seat, status: "PENDING", inviteExpiresAt: NOW }, NOW),
      false,
    );
  },
);

testCase("access lasts between one hour and 90 days", () => {
  assert.throws(() =>
    parseAccessExpiry(new Date(NOW.getTime() + 60_000).toISOString(), NOW),
  );
  assert.throws(() =>
    parseAccessExpiry(new Date(NOW.getTime() + 91 * DAY).toISOString(), NOW),
  );
  assert.throws(() => parseAccessExpiry("not a date", NOW));
  const end = new Date(NOW.getTime() + 30 * DAY);
  assert.equal(
    parseAccessExpiry(end.toISOString(), NOW).getTime(),
    end.getTime(),
  );
});

testCase("storage keys are derived, never taken from a path", () => {
  assert.equal(
    externalPreviewPageKey(PREVIEW, 3),
    `external-previews/${PREVIEW}/3.bin`,
  );
  for (const [id, index] of [
    ["../../etc", 0],
    [`${PREVIEW}/..`, 0],
    [PREVIEW, -1],
    [PREVIEW, 1.5],
    [PREVIEW, 300],
  ] as const) {
    assert.throws(() => externalPreviewPageKey(id, index));
  }
});

testCase(
  "only an exact hybrid X25519 + ML-KEM-768 wrapping is accepted",
  () => {
    assert.equal(isValidHybridWrapping(wrapping()), true);
    assert.equal(
      isValidHybridWrapping({ ...wrapping(), algorithm: "x25519-aes256gcm" }),
      false,
    );
    assert.equal(
      isValidHybridWrapping({ ...wrapping(), kemCiphertext: b64(1087) }),
      false,
    );
    assert.equal(
      isValidHybridWrapping({ ...wrapping(), encryptedKey: b64(32) }),
      false,
    );
    assert.equal(
      isValidHybridWrapping({ ...wrapping(), nonce: "AAAA+AAAAAAAAAAA" }),
      false,
    );
  },
);

// ---------------------------------------------------------------------------
// Route guards
// ---------------------------------------------------------------------------

testCase(
  "admin and contractor routes require an authenticated session",
  () => {
    assert.deepEqual(
      Reflect.getMetadata(GUARDS_METADATA, TeamExternalAdminController),
      [AuthenticatedUserGuard],
    );
    assert.deepEqual(
      Reflect.getMetadata(GUARDS_METADATA, TeamExternalContractorController),
      [AuthenticatedUserGuard],
    );
  },
);

// ---------------------------------------------------------------------------
// Contractor side
// ---------------------------------------------------------------------------

testCase(
  "a contractor only reaches READY copies of their own active seat",
  async () => {
    let where: Record<string, any> | undefined;
    const external = service({
      teamExternalPreview: {
        findFirst: async (args: { where: Record<string, any> }) => {
          where = args.where;
          return null;
        },
      },
    });
    await rejects(external.getContractorPage(contractor(), PREVIEW, 0), 404);
    assert.equal(where!.id, PREVIEW);
    assert.equal(where!.status, "READY");
    assert.equal(where!.deletedAt, null);
    assert.deepEqual(where!.sourceFileId, { not: null });
    assert.deepEqual(where!.team, { isActive: true });
    assert.equal(where!.seat.userId, "contractor");
    assert.equal(where!.seat.status, "ACTIVE");
    assert.ok(where!.seat.accessExpiresAt.gt instanceof Date);
  },
);

testCase(
  "pages outside the preview and accounts without 2FA get the same 404",
  async () => {
    let reads = 0;
    const events: JournalEvent[] = [];
    const external = service(
      {
        teamExternalPreview: {
          findFirst: async () => ({
            id: PREVIEW,
            pageCount: 2,
            teamId: TEAM,
            seatId: SEAT,
          }),
        },
      },
      {
        getFileByKey: async (key: string) => {
          reads++;
          // Journaled before it is served.
          assert.deepEqual(events.at(-1), {
            teamId: TEAM,
            kind: "PAGE",
            actorEmail: "presta@example.test",
            previewId: PREVIEW,
            seatId: SEAT,
            pageIndex: 1,
          });
          assert.equal(key, `external-previews/${PREVIEW}/1.bin`);
          return Buffer.from("cipher");
        },
      },
      auditStub(events),
    );
    await rejects(external.getContractorPage(contractor(), PREVIEW, 2), 404);
    await rejects(external.getContractorPage(contractor(), PREVIEW, -1), 404);
    await rejects(
      external.getContractorPage(
        contractor({ totpVerified: false }),
        PREVIEW,
        1,
      ),
      404,
    );
    await rejects(
      external.listContractorPreviews(contractor({ totpVerified: false })),
      404,
    );
    assert.equal(reads, 0);
    assert.equal(events.length, 0);
    assert.deepEqual(
      await external.getContractorPage(contractor(), PREVIEW, 1),
      Buffer.from("cipher"),
    );
    assert.equal(reads, 1);
  },
);

testCase("a page is not served when the journal cannot record it", async () => {
  let reads = 0;
  const external = service(
    {
      teamExternalPreview: {
        findFirst: async () => ({
          id: PREVIEW,
          pageCount: 2,
          teamId: TEAM,
          seatId: SEAT,
        }),
      },
    },
    { getFileByKey: async () => void reads++ },
    {
      ...auditStub(),
      appendEvent: async () => {
        throw new Error("database down");
      },
    },
  );
  await assert.rejects(external.getContractorPage(contractor(), PREVIEW, 0));
  assert.equal(reads, 0);
});

testCase(
  "storage substitution and revocation during storage latency deny delivery",
  async () => {
    const preview = { id: PREVIEW, pageCount: 1, teamId: TEAM, seatId: SEAT };
    let queries = 0;
    const revoked = service(
      {
        teamExternalPreview: {
          findFirst: async () => (++queries === 1 ? preview : null),
        },
      },
      { getFileByKey: async () => Buffer.from("cipher") },
    );
    await rejects(revoked.getContractorPage(contractor(), PREVIEW, 0), 404);
    const substituted = service(
      { teamExternalPreview: { findFirst: async () => preview } },
      { getFileByKey: async () => Buffer.from("altered") },
    );
    await rejects(substituted.getContractorPage(contractor(), PREVIEW, 0), 409);
  },
);

testCase(
  "a copy stays hidden until its passkey approval matches every page",
  async () => {
    let readyWrites = 0;
    const prisma = {
      ...adminMembership,
      teamExternalPreview: {
        findFirst: async () => ({ id: PREVIEW, pageCount: 1 }),
      },
      teamExternalPreviewPage: { count: async () => 1 },
      $transaction: async (run: (tx: object) => Promise<unknown>) =>
        run({
          $executeRaw: async () => 1,
          teamExternalSeat: { findFirst: async () => ({ id: SEAT }) },
          teamExternalPreview: {
            updateMany: async () => {
              readyWrites++;
              return { count: 1 };
            },
          },
        }),
    };
    const refusing = service(
      prisma,
      {},
      {
        ...auditStub(),
        finalizeIssuance: async () => {
          throw Object.assign(new Error("approval required"), {
            getStatus: () => 403,
          });
        },
      },
    );
    await rejects(refusing.completePreview(TEAM, PREVIEW, admin as never), 403);
    assert.equal(readyWrites, 0);
  },
);

testCase(
  "an invitation is bound to its address, 2FA and post-quantum keys",
  async () => {
    const token = "T".repeat(43);
    const seat = {
      id: SEAT,
      teamId: TEAM,
      email: "presta@example.test",
      status: "PENDING",
      tokenHash: hashExternalToken(token),
      inviteExpiresAt: new Date(Date.now() + DAY),
      accessExpiresAt: new Date(Date.now() + 10 * DAY),
      team: { name: "Team", isActive: true, status: "active" },
    };
    let keys = { x25519: 1, pq: 1 };
    let member: object | null = null;
    let accepted: Record<string, any> | undefined;
    const external = service({
      teamExternalSeat: {
        findUnique: async (args: { where: { tokenHash: string } }) =>
          args.where.tokenHash === seat.tokenHash ? seat : null,
        updateMany: async (args: Record<string, any>) => {
          accepted = args;
          return { count: 1 };
        },
      },
      userIdentityKey: { count: async () => keys.x25519 },
      userPQKey: { count: async () => keys.pq },
      teamMember: { findFirst: async () => member },
      teamAccessLog: { create: async () => ({}) },
    });

    await rejects(external.acceptInvitation("short", contractor()), 404);
    await rejects(external.acceptInvitation("X".repeat(43), contractor()), 404);
    await rejects(
      external.acceptInvitation(
        token,
        contractor({ email: "other@example.test" }),
      ),
      403,
    );
    await rejects(
      external.acceptInvitation(token, contractor({ totpVerified: false })),
      403,
    );
    keys = { x25519: 1, pq: 0 };
    await rejects(external.acceptInvitation(token, contractor()), 409);
    keys = { x25519: 1, pq: 1 };
    member = { id: "m" };
    await rejects(external.acceptInvitation(token, contractor()), 409);
    member = null;
    assert.equal(accepted, undefined);

    await external.acceptInvitation(
      token,
      contractor({ email: "Presta@Example.test" }),
    );
    assert.equal(accepted!.where.tokenHash, seat.tokenHash);
    assert.equal(accepted!.where.status, "PENDING");
    assert.equal(accepted!.data.userId, "contractor");
    assert.equal(accepted!.data.tokenHash, null);
  },
);

// ---------------------------------------------------------------------------
// Admin side
// ---------------------------------------------------------------------------

testCase("only an admin of an active team manages contractors", async () => {
  let where: Record<string, any> | undefined;
  const external = service({
    teamMember: {
      findFirst: async (args: { where: Record<string, any> }) => {
        where = args.where;
        return null;
      },
    },
  });
  await rejects(external.listSeats(TEAM, admin as never), 403);
  assert.deepEqual(where!.role, { in: ["OWNER", "ADMIN"] });
  assert.equal(where!.isActive, true);
  assert.deepEqual(where!.team, { isActive: true });
});

testCase("external seats are unlimited by default and retain invitation isolation", async () => {
  const future = new Date(Date.now() + 10 * DAY);
  const seats = [
    {
      id: "a",
      email: "a@example.test",
      status: "ACTIVE",
      userId: "a",
      inviteExpiresAt: future,
      accessExpiresAt: future,
    },
    {
      id: "b",
      email: "b@example.test",
      status: "PENDING",
      userId: null,
      inviteExpiresAt: future,
      accessExpiresAt: future,
    },
  ];
  let upserts = 0;
  const tx = {
    $executeRaw: async () => 1,
    teamExternalSeat: {
      findMany: async () => seats,
      upsert: async () => {
        upserts++;
        return { id: "c", tokenHash: "h" };
      },
    },
    teamExternalPreview: { updateMany: async () => ({ count: 0 }) },
    teamExternalRevocationWatch: { updateMany: async () => ({ count: 0 }) },
  };
  const external = service({
    ...adminMembership,
    team: { findUnique: async () => ({ name: "Team" }) },
    teamInvitation: {
      findFirst: async (args: { where: { email: string } }) =>
        args.where.email === "pending@example.test" ? { id: "invite" } : null,
    },
    teamMember: {
      findFirst: async (args: { where: { user?: unknown } }) =>
        args.where.user ? null : { id: "member" },
    },
    $transaction: async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
  });
  const accessExpiresAt = new Date(Date.now() + 5 * DAY).toISOString();
  await external.inviteSeat(TEAM, admin as never, {
    email: "c@example.test",
    accessExpiresAt,
  });
  assert.equal(upserts, 1);
  await rejects(
    external.inviteSeat(TEAM, admin as never, {
      email: "a@example.test",
      accessExpiresAt,
    }),
    409,
  );
  await rejects(
    external.inviteSeat(TEAM, admin as never, {
      email: "pending@example.test",
      accessExpiresAt,
    }),
    409,
  );
  assert.equal(upserts, 1);
  seats[1].status = "REVOKED";
  const result = await external.inviteSeat(TEAM, admin as never, {
    email: "c@example.test",
    accessExpiresAt,
  });
  assert.equal(upserts, 2);
  assert.match(
    result.inviteUrl,
    /^https:\/\/app\/external\/invite\/[A-Za-z0-9_-]{43}$/,
  );
});

testCase(
  "a copy needs a usable seat, a hybrid wrapping and a source of the same team",
  async () => {
    let sourceWhere: Record<string, any> | undefined;
    let created = 0;
    let seat: object | null = {
      id: SEAT,
      status: "ACTIVE",
      userId: "contractor",
      inviteExpiresAt: new Date(Date.now() + DAY),
      accessExpiresAt: new Date(Date.now() + DAY),
    };
    let source: object | null = null;
    const external = service({
      ...adminMembership,
      teamExternalSeat: { findFirst: async () => seat },
      file: {
        findFirst: async (args: { where: Record<string, any> }) => {
          sourceWhere = args.where;
          return source;
        },
      },
      teamExternalPreview: {
        count: async () => 0,
        create: async () => {
          created++;
          return { id: PREVIEW };
        },
      },
    });
    const dto = {
      id: PREVIEW,
      seatId: SEAT,
      sourceFileId: "44444444-4444-4444-8444-444444444444",
      pageCount: 2,
      encryptedManifest: "manifest",
      ...wrapping(),
    };
    await rejects(
      external.createPreview(TEAM, admin as never, {
        ...dto,
        algorithm: "x25519-aes256gcm",
      }),
      400,
    );
    await rejects(external.createPreview(TEAM, admin as never, dto), 404);
    assert.deepEqual(sourceWhere!.share, {
      hasBeenCompleted: true,
      teamFolder: { teamId: TEAM },
    });
    source = { id: dto.sourceFileId };
    seat = null;
    await rejects(external.createPreview(TEAM, admin as never, dto), 404);
    assert.equal(created, 0);
  },
);

testCase(
  "pages are bounded encrypted blobs uploaded by the copy's creator only",
  async () => {
    let previewWhere: Record<string, any> | undefined;
    const stored: string[] = [];
    const hashes: string[] = [];
    const external = service(
      {
        ...adminMembership,
        teamExternalPreview: {
          findFirst: async (args: { where: Record<string, any> }) => {
            previewWhere = args.where;
            return { id: PREVIEW, pageCount: 2 };
          },
        },
        teamExternalPreviewPage: {
          upsert: async (args: { create: { sha256: string } }) => {
            hashes.push(args.create.sha256);
            return {};
          },
        },
      },
      { storeFileByKey: async (key: string) => void stored.push(key) },
    );
    await rejects(
      external.uploadPage(TEAM, PREVIEW, 2, admin as never, Buffer.alloc(64)),
      400,
    );
    await rejects(
      external.uploadPage(TEAM, PREVIEW, 0, admin as never, "text"),
      400,
    );
    await rejects(
      external.uploadPage(TEAM, PREVIEW, 0, admin as never, {
        length: 64,
      }),
      400,
    );
    await rejects(
      external.uploadPage(TEAM, PREVIEW, 0, admin as never, new Uint8Array(64)),
      400,
    );
    await rejects(
      external.uploadPage(TEAM, PREVIEW, 0, admin as never, Buffer.alloc(10)),
      400,
    );
    await rejects(
      external.uploadPage(
        TEAM,
        PREVIEW,
        0,
        admin as never,
        Buffer.alloc(EXTERNAL_PAGE_MAX_BYTES + 1),
      ),
      400,
    );
    assert.deepEqual(stored, []);
    await external.uploadPage(
      TEAM,
      PREVIEW,
      1,
      admin as never,
      Buffer.alloc(64),
    );
    assert.deepEqual(stored, [`external-previews/${PREVIEW}/1.bin`]);
    // The register entry is checked against this hash before READY.
    assert.deepEqual(hashes, [
      "f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b",
    ]);
    assert.equal(previewWhere!.createdById, "admin");
    assert.equal(previewWhere!.status, "UPLOADING");
    assert.equal(previewWhere!.teamId, TEAM);
  },
);

testCase(
  "revoking a seat hides its copies at once and purges their pages",
  async () => {
    const deleted: string[] = [];
    let hidden: Record<string, any> | undefined;
    const prisma = {
      ...adminMembership,
      teamExternalSeat: {
        findFirst: async () => ({ email: "presta@example.test" }),
        update: (args: unknown) => args,
        deleteMany: async () => ({ count: 0 }),
      },
      teamExternalPreview: {
        updateMany: (args: Record<string, any>) => {
          hidden = args;
          return args;
        },
        findMany: async () => [{ id: PREVIEW, pageCount: 2 }],
        deleteMany: async () => ({ count: 1 }),
      },
      teamAccessLog: { create: async () => ({}) },
      $transaction: async (operations: unknown[]) => operations,
    };
    const external = service(prisma, {
      deleteFileByKey: async (key: string) => {
        deleted.push(key);
        if (key.endsWith("1.bin")) throw new Error("missing");
      },
    });
    await external.revokeSeat(TEAM, SEAT, admin as never);
    assert.equal(hidden!.where.seatId, SEAT);
    assert.ok(hidden!.data.deletedAt instanceof Date);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(deleted, [
      `external-previews/${PREVIEW}/0.bin`,
      `external-previews/${PREVIEW}/1.bin`,
    ]);
  },
);

// ---------------------------------------------------------------------------
// No other path to the originals
// ---------------------------------------------------------------------------

testCase(
  "no grant of a team file can be wrapped for a contractor of that team",
  async () => {
    let member: object | null = null;
    const grants = new AccessGrantService({
      userIdentityKey: { findFirst: async () => ({ id: "key" }) },
      file: {
        findUnique: async () => ({ share: { teamFolder: { teamId: TEAM } } }),
      },
      teamExternalSeat: { findFirst: async () => ({ id: SEAT }) },
      teamMember: { findFirst: async () => member },
      accessGrant: {
        findFirst: async () => null,
        create: async () => ({ id: "grant", dekVersion: 1 }),
      },
    } as never);
    Object.assign(grants, {
      validateGrantorAccess: async () => undefined,
      logTeamGrantEvent: async () => undefined,
      logger: { log: () => undefined },
    });
    const dto = {
      recipientUserId: "contractor",
      fileId: "file",
      encryptedFileKey: "k",
      ephemeralPublicKey: "e",
      nonce: "n",
    };
    await rejects(grants.createGrant("member", dto as never), 403);
    member = { id: "m" };
    assert.equal(
      (await grants.createGrant("member", dto as never)).action,
      "created",
    );
  },
);

testCase("a contractor of the team cannot also become a member", async () => {
  let where: Record<string, any> | undefined;
  let seat: object | null = { id: SEAT };
  const team = new TeamService(
    {
      teamExternalSeat: {
        findFirst: async (args: { where: Record<string, any> }) => {
          where = args.where;
          return seat;
        },
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const guard = (email: string, userId?: string) =>
    (team as any).assertNotExternalContractor(TEAM, email, userId);
  await rejects(guard("presta@example.test", "contractor"), 409);
  assert.equal(where!.teamId, TEAM);
  assert.deepEqual(where!.status, { in: ["PENDING", "ACTIVE"] });
  assert.ok(where!.accessExpiresAt.gt instanceof Date);
  assert.deepEqual(where!.OR, [
    { email: "presta@example.test" },
    { userId: "contractor" },
  ]);
  seat = null;
  await guard("presta@example.test");
  assert.deepEqual(where!.OR, [{ email: "presta@example.test" }]);
});

void run();
