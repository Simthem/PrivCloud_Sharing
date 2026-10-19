import "reflect-metadata";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { Prisma } from "@prisma/client";
import { canonicalJson } from "src/signing/signing-evidence.util";
import { AccountPasskeyService } from "src/passkey/accountPasskey.service";
import { TeamExternalAuditService } from "src/teamExternal/team-external-audit.service";
import {
  AUDIT_CHAIN_START,
  auditEventHash,
  legacyAuditEventHash,
  buildIssuanceManifest,
  issuanceChallenge,
  issuanceRecordHash,
  isValidIssuanceInput,
  type IssuanceInput,
  verifyAuditChain,
} from "src/teamExternal/team-external-audit.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("contractor audit");

const TEAM = "11111111-1111-4111-8111-111111111111";
const PREVIEW = "22222222-2222-4222-8222-222222222222";
const SEAT = "33333333-3333-4333-8333-333333333333";
const FILE = "44444444-4444-4444-8444-444444444444";
const HEX = (char: string) => char.repeat(64);
const admin = { id: "admin", email: "admin@example.test", username: "admin" };

const page = (char: string) => ({
  plainSha256: HEX(char),
  cipherSha256: HEX(char === "a" ? "b" : "d"),
  width: 1400,
  height: 1800,
});
const description = {
  markId: "0123456789abcdef0123456789abcdef",
  sourceSha256: HEX("e"),
  pages: [page("a"), page("c")],
};

function manifest(client: IssuanceInput = description) {
  return buildIssuanceManifest({
    nonce: randomBytes(32).toString("base64url"),
    issuedAt: new Date("2026-10-07T10:00:00Z"),
    team: { id: TEAM, name: "Équipe" },
    issuer: { userId: "admin", email: admin.email },
    contractor: { seatId: SEAT, email: "presta@example.test", name: "Presta" },
    accessExpiresAt: new Date("2026-11-07T10:00:00Z"),
    previewId: PREVIEW,
    sourceFileId: FILE,
    client,
  });
}

async function rejects(promise: Promise<unknown>, status: number) {
  await assert.rejects(promise, (error: { getStatus?: () => number }) => {
    assert.equal(error.getStatus?.(), status);
    return true;
  });
}

function chain(length: number) {
  const events = [];
  let prevHash = AUDIT_CHAIN_START;
  for (let seq = 1; seq <= length; seq++) {
    const content = {
      teamId: TEAM,
      seq,
      at: new Date(Date.UTC(2026, 9, 7, 10, seq)),
      kind: seq === 1 ? "ISSUED" : "PAGE",
      previewId: PREVIEW,
      seatId: SEAT,
      actorEmail: "presta@example.test",
      pageIndex: seq === 1 ? null : seq - 2,
      prevHash,
    };
    const hash = auditEventHash(content);
    events.push({ ...content, hash });
    prevHash = hash;
  }
  return events;
}

function auditService(prisma: Record<string, unknown>, pdfSigning = {}) {
  const service = new TeamExternalAuditService(
    {
      teamMember: { findFirst: async () => ({ id: "member" }) },
      signingTimestamp: { findMany: async () => [] },
      ...prisma,
    } as never,
    { get: () => "PrivCloud" } as never,
    pdfSigning as never,
    { verifyTeamEvidence: async () => undefined } as never,
  );
  Object.assign(service, {
    logger: { warn: () => undefined, log: () => undefined },
  });
  return service;
}

testCase("the passkey signs the SHA-256 of the canonical manifest", () => {
  const value = manifest();
  const { canonical, hash } = issuanceChallenge(value);
  assert.equal(canonical, canonicalJson(value));
  assert.equal(hash, createHash("sha256").update(canonical).digest("hex"));
  // The browser only describes the copy, everything else is the server's.
  assert.equal(value.contractor.email, "presta@example.test");
  assert.equal(value.copy.pages[1].cipherSha256, HEX("d"));
  assert.notEqual(
    issuanceChallenge({ ...value, accessExpiresAt: "2027-01-01" }).hash,
    hash,
  );
});

testCase(
  "the signed manifest binds the visible copy marker algorithm when present",
  () => {
    const input = {
      ...description,
      visibleMarkAlgorithm: "privcloud:visible-copy:v1" as const,
    }
    assert.equal(isValidIssuanceInput(input, input.pages.length), true)
    assert.equal(
      manifest(input).copy.visibleMarkAlgorithm,
      input.visibleMarkAlgorithm,
    )
    assert.equal(
      isValidIssuanceInput(
        { ...input, visibleMarkAlgorithm: "unknown" },
        input.pages.length,
      ),
      false,
    )
    const current = manifest()
    const visible = {
      ...current,
      copy: {
        ...current.copy,
        visibleMarkAlgorithm: input.visibleMarkAlgorithm,
      },
    }
    assert.notEqual(
      issuanceChallenge(visible).hash,
      issuanceChallenge(current).hash,
    )
  },
)

testCase(
  "the signed manifest binds the whole-page multiscale carrier and rejects unknown versions",
  () => {
    const input = {
      ...description,
      robustMarkAlgorithm: "privcloud:forensic-multiscale:v2" as const,
    }
    assert.equal(isValidIssuanceInput(input, input.pages.length), true)
    assert.equal(
      manifest(input).copy.robustMarkAlgorithm,
      input.robustMarkAlgorithm,
    )
    assert.equal(
      isValidIssuanceInput(
        { ...input, robustMarkAlgorithm: "unknown" },
        input.pages.length,
      ),
      false,
    )
    const current = manifest()
    const robust = {
      ...current,
      copy: { ...current.copy, robustMarkAlgorithm: input.robustMarkAlgorithm },
    }
    assert.notEqual(
      issuanceChallenge(robust).hash,
      issuanceChallenge(current).hash,
    )
  },
)

testCase("a copy description is checked field by field", () => {
  assert.equal(isValidIssuanceInput(description, 2), true);
  assert.equal(isValidIssuanceInput(description, 3), false);
  assert.equal(
    isValidIssuanceInput({ ...description, markId: "XYZ" }, 2),
    false,
  );
  assert.equal(
    isValidIssuanceInput({ ...description, sourceSha256: HEX("g") }, 2),
    false,
  );
  assert.equal(
    isValidIssuanceInput(
      { ...description, pages: [page("a"), { ...page("c"), width: 0 }] },
      2,
    ),
    false,
  );
  assert.equal(isValidIssuanceInput(null, 2), false);
});

testCase("the journal reveals an edited, removed or reordered event", () => {
  const events = chain(5);
  assert.deepEqual(verifyAuditChain(events, []), {
    valid: true,
    brokenAtSeq: null,
  });
  const edited = events.map((event) =>
    event.seq === 3 ? { ...event, pageIndex: 7 } : event,
  );
  assert.equal(verifyAuditChain(edited, []).brokenAtSeq, 3);
  const removed = events.filter((event) => event.seq !== 3);
  assert.equal(verifyAuditChain(removed, []).brokenAtSeq, 4);
  // Rewriting every hash after an edit is caught by the timestamped anchor.
  assert.equal(
    verifyAuditChain(events, [{ seq: 4, hash: HEX("f") }]).brokenAtSeq,
    4,
  );
  // Events purged after the retention: the chain resumes where it remains.
  assert.equal(verifyAuditChain(events.slice(2), []).valid, true);
});

testCase(
  "journal diagnostics distinguish content, sequence, genesis and anchors without rewriting events",
  () => {
    const events = chain(3)
    const edited = events.map((event) =>
      event.seq === 1
        ? { ...event, actorEmail: "different@example.test" }
        : event,
    )
    assert.equal(verifyAuditChain(edited, []).reason, "content_hash_mismatch")
    assert.equal(
      verifyAuditChain([events[0], events[2]], []).reason,
      "sequence_gap",
    )
    assert.equal(
      verifyAuditChain(events, [{ seq: 1, hash: HEX("f") }]).reason,
      "anchor_mismatch",
    )
    const genesis = { ...events[0], prevHash: HEX("a") }
    assert.equal(
      verifyAuditChain([{ ...genesis, hash: auditEventHash(genesis) }], [])
        .reason,
      "genesis_mismatch",
    )
    const relinked = { ...events[1], prevHash: HEX("b") }
    assert.equal(
      verifyAuditChain(
        [events[0], { ...relinked, hash: auditEventHash(relinked) }],
        [],
      ).reason,
      "previous_hash_mismatch",
    )
    assert.equal(verifyAuditChain(events, []).valid, true)
  },
)

testCase(
  "historical flat events remain verifiable before the split format without changing stored hashes",
  () => {
    const events = chain(4)
    for (let index = 0; index < events.length; index++) {
      if (index > 0) events[index].prevHash = events[index - 1].hash
      events[index].hash =
        index < 2
          ? legacyAuditEventHash(events[index])
          : auditEventHash(events[index])
    }
    const stored = events.map((event) => event.hash)
    assert.equal(
      verifyAuditChain(events, [{ seq: 4, hash: stored[3] }]).valid,
      true,
    )
    assert.deepEqual(
      events.map((event) => event.hash),
      stored,
    )
    assert.equal(
      verifyAuditChain(
        [{ ...events[0], pageIndex: 99 }, ...events.slice(1)],
        [],
      ).valid,
      false,
    )
    assert.equal(
      verifyAuditChain(events, [{ seq: 4, hash: HEX("f") }]).valid,
      false,
    )
    events[3].hash = legacyAuditEventHash(events[3])
    assert.equal(verifyAuditChain(events, []).reason, "format_downgrade")
  },
)

testCase("events extend the chain of their team under a lock", async () => {
  const [first, second] = chain(2);
  let locked = "";
  let written: Record<string, any> | undefined;
  const service = auditService({
    $transaction: async (work: (tx: object) => Promise<unknown>) =>
      work({
        $executeRaw: async (strings: TemplateStringsArray, key: string) => {
          assert.match(strings[0], /^UPDATE "TeamExternalAuditEvent"/);
          locked = key;
        },
        teamExternalAuditEvent: {
          findFirst: async () => ({ seq: first.seq, hash: first.hash }),
          create: async (args: { data: Record<string, any> }) => {
            written = args.data;
          },
        },
      }),
  });
  await service.appendEvent({
    teamId: TEAM,
    kind: "PAGE",
    actorEmail: "presta@example.test",
    previewId: PREVIEW,
    seatId: SEAT,
    pageIndex: 0,
  });
  assert.equal(locked, TEAM);
  assert.equal(written!.seq, second.seq);
  assert.equal(written!.prevHash, first.hash);
  assert.equal(written!.hash, auditEventHash(written as never));
});

testCase(
  "private journal diagnostics enforce team-admin access and only read the failing event",
  async () => {
    await rejects(
      auditService({
        teamMember: { findFirst: async () => null },
      }).journalDiagnostic(TEAM, admin as never),
      403,
    )
    const [event] = chain(1)
    const broken = { ...event, pageIndex: 99 }
    const service = auditService({
      teamExternalAuditAnchor: { findMany: async () => [] },
      teamExternalAuditEvent: {
        findMany: async ({ where }: { where: { seq: { gt: number } } }) =>
          where.seq.gt < 1 ? [broken] : [],
        findUnique: async ({
          where,
        }: {
          where: { teamId_seq: { teamId: string; seq: number } }
        }) => {
          assert.deepEqual(where, { teamId_seq: { teamId: TEAM, seq: 1 } })
          return broken
        },
      },
    })
    const result = await service.journalDiagnostic(TEAM, admin as never)
    assert.equal(result.verification.valid, false)
    assert.equal(result.verification.reason, "content_hash_mismatch")
    assert.equal(result.event?.storedHash, event.hash)
    assert.notEqual(result.event?.calculatedHash, event.hash)
    assert.equal(broken.hash, event.hash)
  },
)

testCase(
  "a truncated or fully deleted journal cannot hide an existing anchor",
  async () => {
    const all = chain(4);
    for (const retained of [all.slice(0, 3), []]) {
      const service = auditService({
        teamExternalAuditAnchor: {
          findMany: async () => [{ seq: 4, hash: all[3].hash }],
        },
        teamExternalAuditEvent: {
          findMany: async ({ where }: { where: { seq: { gt: number } } }) =>
            retained.filter((event) => event.seq > where.seq.gt),
        },
      });
      const result = await service.verifyChain(TEAM);
      assert.equal(result.valid, false);
      assert.equal(result.brokenAtSeq, 4);
    }
  },
);

testCase(
  "a copy is issued only when every stored page is the approved one",
  async () => {
    const service = auditService({});
    const stored = [
      { index: 0, sha256: HEX("b") },
      { index: 1, sha256: HEX("d") },
    ];
    let issued = 0;
    const tx = (issuance: object | null, pages = stored) => ({
      teamExternalIssuance: {
        findUnique: async () => issuance,
        update: async () => void issued++,
      },
      teamExternalPreviewPage: { findMany: async () => pages },
      teamExternalPreview: { findFirst: async () => ({ id: PREVIEW }) },
    });
    const approved = {
      id: "issuance",
      status: "APPROVED",
      manifest: canonicalJson(manifest()),
    };
    await rejects(service.finalizeIssuance(tx(null) as never, PREVIEW), 403);
    await rejects(
      service.finalizeIssuance(
        tx({ ...approved, status: "ISSUED" }) as never,
        PREVIEW,
      ),
      403,
    );
    await rejects(
      service.finalizeIssuance(
        tx(approved, [stored[0], { index: 1, sha256: HEX("0") }]) as never,
        PREVIEW,
      ),
      409,
    );
    assert.equal(issued, 0);
    assert.equal(
      await service.finalizeIssuance(tx(approved) as never, PREVIEW),
      "issuance",
    );
    assert.equal(issued, 1);
  },
);

testCase(
  "the team audit key is created once, with the current key",
  async () => {
    let fail: Error | null = null;
    const service = auditService({
      team: { findUnique: async () => ({ keyVersion: 3 }) },
      teamAuditKey: {
        create: async (args: { data: object }) => {
          if (fail) throw fail;
          return args.data;
        },
      },
    });
    const wrapped = randomBytes(60).toString("base64url");
    await rejects(
      service.createAuditKey(TEAM, admin as never, {
        encryptedKey: wrapped,
        keyVersion: 2,
      }),
      409,
    );
    await rejects(
      service.createAuditKey(TEAM, admin as never, {
        encryptedKey: wrapped.slice(0, 5),
        keyVersion: 3,
      }),
      400,
    );
    fail = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
    });
    await rejects(
      service.createAuditKey(TEAM, admin as never, {
        encryptedKey: wrapped,
        keyVersion: 3,
      }),
      409,
    );
  },
);

testCase(
  "approving needs a passkey, whose handle never replaces a signing one",
  async () => {
    const created: Record<string, any>[] = [];
    const passkeys = new AccountPasskeyService(
      {
        accountPasskey: { findMany: async () => [] },
        signingPasskey: { findMany: async () => [] },
        passkeyChallenge: {
          deleteMany: async () => ({ count: 0 }),
          updateMany: async () => ({ count: 0 }),
          create: async (args: { data: Record<string, any> }) => {
            created.push(args.data);
            return { id: "challenge" };
          },
        },
      } as never,
      {
        get: (key: string) =>
          key === "general.appUrl" ? "https://share.example.test" : "PrivCloud",
      } as never,
    );
    await rejects(
      passkeys.beginIssue(admin as never, PREVIEW, "{}", HEX("a")),
      403,
    );
    const { options } = await passkeys.beginRegistration(admin as never);
    assert.equal(
      Buffer.from(options.user.id, "base64url").toString(),
      "account:admin",
    );
    assert.equal(options.rp.id, "share.example.test");
    assert.equal(options.authenticatorSelection?.userVerification, "required");
    assert.equal(created[0].purpose, "REGISTER");
  },
);

testCase(
  "the certificate carries its evidence and survives a missing seal",
  async () => {
    const value = manifest();
    const service = auditService(
      {
        teamExternalIssuance: {
          findFirst: async () => ({
            id: "55555555-5555-4555-8555-555555555555",
            previewId: PREVIEW,
            manifest: canonicalJson(value),
            manifestHash: HEX("1"),
            credentialId: randomBytes(16).toString("base64url"),
            credentialPublicKey: randomBytes(77).toString("base64url"),
            credentialAlgorithm: -7,
            authenticatorData: "data",
            clientDataJSON: "client",
            signature: randomBytes(70).toString("base64url"),
            userHandle: null,
            recordHash: HEX("2"),
            timestampToken: null,
            timestampedAt: null,
            issuerEmail: admin.email,
          }),
        },
        teamExternalAuditEvent: { findMany: async () => chain(3) },
        teamExternalAuditAnchor: { findMany: async () => [] },
      },
      {
        signPdf: async () => {
          throw new Error("no certificate");
        },
      },
    );
    const pdf = await service.certificate(
      TEAM,
      "issuance",
      admin as never,
      {} as never,
    )
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    const { PDFDocument } = await import("pdf-lib");
    const document = await PDFDocument.load(pdf);
    assert.equal(document.getTitle(), "Certificat de mise à disposition");
    assert.ok(pdf.includes(Buffer.from("preuve.json")));
    // The bundle works without any PDF viewer.
    const bundle = await service.evidenceBundle(
      TEAM,
      "issuance",
      admin as never,
      {} as never,
    );
    assert.equal(bundle.subarray(0, 2).toString(), "PK");
    for (const name of ["certificat.pdf", "preuve.json", "LISEZMOI.txt"]) {
      assert.ok(bundle.includes(Buffer.from(name)), name);
    }
  },
);

const ORIGIN = "https://share.example.test";
const b64url = (value: Buffer | Uint8Array) =>
  Buffer.from(value).toString("base64url");

/**
 * A register entry approved by a real P-256 passkey, and a team chain where
 * the events of this copy alternate with those of another one.
 */
function signedEvidence(
  tokens: {
    record?: (hash: string) => Promise<string | null>;
    anchor?: (hash: string) => Promise<string | null>;
  } = {},
) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
      [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
    ]),
  );
  const canonical = canonicalJson(manifest());
  const manifestHash = createHash("sha256").update(canonical).digest("hex");
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: b64url(Buffer.from(manifestHash, "hex")),
      origin: ORIGIN,
      crossOrigin: false,
    }),
  );
  const authenticatorData = Buffer.concat([
    createHash("sha256").update(new URL(ORIGIN).hostname).digest(),
    Buffer.from([0x05, 0, 0, 0, 1]),
  ]);
  const record = {
    manifest: canonical,
    credentialId: b64url(randomBytes(16)),
    credentialPublicKey: b64url(cose),
    credentialAlgorithm: -7,
    authenticatorData: b64url(authenticatorData),
    clientDataJSON: b64url(clientDataJSON),
    signature: b64url(
      sign(
        "sha256",
        Buffer.concat([
          authenticatorData,
          createHash("sha256").update(clientDataJSON).digest(),
        ]),
        privateKey,
      ),
    ),
  };
  const recordHash = issuanceRecordHash(record);
  const other = randomUUID();
  const events: (ReturnType<typeof chain>[number] & { previewId: string })[] =
    [];
  let prevHash = AUDIT_CHAIN_START;
  for (let seq = 1; seq <= 7; seq++) {
    const content = {
      teamId: TEAM,
      seq,
      at: new Date(Date.UTC(2026, 9, 7, 10, seq)),
      kind: seq === 1 ? "ISSUED" : seq === 3 ? "OPENED" : "PAGE",
      previewId: seq % 2 ? PREVIEW : other,
      seatId: SEAT,
      actorEmail: seq === 1 ? admin.email : "presta@example.test",
      pageIndex: seq === 1 || seq === 3 ? null : seq % 3,
      prevHash,
    };
    const hash = auditEventHash(content);
    events.push({ ...content, hash });
    prevHash = hash;
  }
  return async () => {
    const anchorToken = await tokens.anchor?.(events[4].hash);
    const anchors = anchorToken
      ? [{ seq: 5, hash: events[4].hash, timestampToken: anchorToken }]
      : [];
    const issuance = {
      id: randomUUID(),
      previewId: PREVIEW,
      ...record,
      manifestHash,
      userHandle: null,
      recordHash,
      timestampToken: (await tokens.record?.(recordHash)) ?? null,
      timestampedAt: new Date(),
      issuerEmail: admin.email,
    };
    type Where = {
      previewId?: string;
      seq?: { gt?: number; gte?: number; lte?: number; in?: number[] };
    };
    const matches = (row: { seq: number; previewId?: string }, where: Where) =>
      (!where.previewId || row.previewId === where.previewId) &&
      (where.seq?.gt === undefined || row.seq > where.seq.gt) &&
      (where.seq?.gte === undefined || row.seq >= where.seq.gte) &&
      (where.seq?.lte === undefined || row.seq <= where.seq.lte) &&
      (where.seq?.in === undefined || where.seq.in.includes(row.seq));
    return auditService(
      {
        teamExternalIssuance: { findFirst: async () => issuance },
        teamExternalAuditEvent: {
          findMany: async (args: { where: Where }) =>
            events.filter((event) => matches(event, args.where)),
        },
        teamExternalAuditAnchor: {
          findMany: async (args: { where: Where }) =>
            anchors.filter((anchor) => matches(anchor, args.where)),
        },
      },
      {
        signPdf: async () => {
          throw new Error("no certificate");
        },
      },
    ).evidenceBundle(TEAM, issuance.id, admin as never, {} as never);
  };
}

testCase(
  "a failed TSA response cannot fabricate an anchor or prevent other team checkpoints",
  async () => {
    const written: Array<{ teamId: string }> = [];
    let requests = 0;
    const service = auditService(
      {
        teamExternalAuditEvent: {
          groupBy: async () => [
            { teamId: "first", _max: { seq: 1 } },
            { teamId: "second", _max: { seq: 1 } },
          ],
          findUnique: async () => ({ hash: HEX("a") }),
        },
        teamExternalAuditAnchor: {
          findFirst: async () => null,
          create: async ({ data }: { data: { teamId: string } }) =>
            written.push(data),
        },
      },
      {
        getTimestamp: async () =>
          ++requests === 1 ? null : Buffer.from("synthetic TSA response"),
      },
    );
    await service.anchorChains();
    assert.equal(requests, 2);
    assert.deepEqual(
      written.map((row) => row.teamId),
      ["second"],
    );
  },
);

testCase(
  "a timestamped evidence ZIP exports a separately retainable checkpoint",
  async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "privcloud-checkpoint-bundle-"),
    );
    try {
      writeFileSync(
        join(directory, "bundle.zip"),
        await signedEvidence({
          record: async () =>
            Buffer.from("synthetic issuance token").toString("base64"),
          anchor: async () =>
            Buffer.from("synthetic anchor token").toString("base64"),
        })(),
      );
      assert.equal(
        spawnSync("python3", ["-I", "-m", "zipfile", "-e", "bundle.zip", "."], {
          cwd: directory,
        }).status,
        0,
      );
      const checkpoint = JSON.parse(
        readFileSync(join(directory, "checkpoint.json"), "utf8"),
      );
      const proof = JSON.parse(
        readFileSync(join(directory, "preuve.json"), "utf8"),
      );
      assert.equal(checkpoint.format, "privcloud-contractor-checkpoint-v1");
      assert.equal(checkpoint.issuance.recordHash, proof.issuance.recordHash);
      assert.equal(checkpoint.journal.teamId, proof.journal.teamId);
      assert.deepEqual(checkpoint.journal, {
        teamId: proof.journal.teamId,
        ...proof.journal.anchors.at(-1),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

const hasTool = (command: string, flag: string) =>
  spawnSync(command, [flag]).status === 0;

testCase("the script of the bundle checks it without PrivCloud", async () => {
  // Python and OpenSSL are what an auditor needs: skipped where absent.
  if (!hasTool("python3", "--version") || !hasTool("openssl", "version")) {
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "privcloud-evidence-"));
  try {
    writeFileSync(join(directory, "bundle.zip"), await signedEvidence()());
    spawnSync("python3", ["-I", "-m", "zipfile", "-e", "bundle.zip", "."], {
      cwd: directory,
    });
    const verify = (...args: string[]) =>
      spawnSync("python3", ["-I", join(directory, "verifier.py"), ...args], {
        encoding: "utf8",
      });
    let result = verify();
    assert.equal(result.status, 0, result.stdout);
    for (const line of [
      "La passkey a signé exactement ce manifeste.",
      "La signature de la passkey est valide.",
      "L'empreinte de l'enregistrement est exacte.",
      "Les 4 événements de cette copie sont intacts.",
      "La chaîne est continue sur les 7 maillons fournis.",
      "Pas encore de jeton d'horodatage",
      "4 événement(s) pas encore horodaté(s)",
    ]) {
      assert.ok(result.stdout.includes(line), line);
    }
    // The events of the other copy show as bare links.
    const file = join(directory, "preuve.json");
    const original = readFileSync(file, "utf8");
    const { journal } = JSON.parse(original);
    assert.deepEqual(
      journal.events.map((event: { seq: number }) => event.seq),
      [1, 3, 5, 7],
    );
    assert.deepEqual(Object.keys(journal.links[1]).sort(), [
      "contentHash",
      "hash",
      "prevHash",
      "seq",
    ]);

    const tampered = (edit: (evidence: any) => void) => {
      const evidence = JSON.parse(original);
      edit(evidence);
      writeFileSync(file, JSON.stringify(evidence));
      return verify();
    };
    result = tampered((evidence) => {
      evidence.journal.events[2].pageIndex = 9;
    });
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes("L'événement n°5 a été modifié."));
    result = tampered((evidence) => {
      evidence.journal.links.splice(3, 1);
    });
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes("La chaîne est rompue au maillon n°5."));
    result = tampered((evidence) => {
      evidence.issuance.manifest = evidence.issuance.manifest.replace(
        "presta@example.test",
        "autre@example.test",
      );
    });
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes("Le manifeste a été modifié"));
    result = tampered((evidence) => {
      const signature = Buffer.from(
        evidence.issuance.webauthn.signatureBase64Url,
        "base64url",
      );
      signature[signature.length - 1] ^= 1;
      evidence.issuance.webauthn.signatureBase64Url =
        signature.toString("base64url");
    });
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes("La signature de la passkey est fausse."));

    writeFileSync(join(directory, "original.bin"), "not the source");
    writeFileSync(file, original);
    result = verify("--original", join(directory, "original.bin"));
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes("n'est pas celui"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

testCase(
  "pattern export authorization rechecks membership and records no secret",
  async () => {
    const confirmations: unknown[] = [],
      logs: Record<string, unknown>[] = []
    const service = auditService({
      teamExternalIssuance: {
        findFirst: async () => ({
          markId: description.markId,
          manifest: canonicalJson(manifest()),
        }),
      },
      teamAccessLog: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          logs.push(data)
        },
      },
    })
    Object.assign(service, {
      approval: {
        verifyTeamEvidence: async (...args: unknown[]) => {
          confirmations.push(args)
        },
      },
    })
    const result = await service.authorizePatternExport(
      TEAM,
      "issuance",
      admin as never,
      {} as never,
    )
    assert.equal(result.markId, description.markId)
    assert.equal((confirmations[0] as unknown[])[3], "pattern")
    assert.equal(logs.length, 1)
    assert.equal(logs[0].action, "EXTERNAL_PATTERN_EXPORT_AUTHORIZED")
    assert.deepEqual(Object.keys(result).sort(), [
      "markId",
      "robustMarkAlgorithm",
    ])
  },
)

testCase(
  "a lost administrator role prevents pattern permission after confirmation",
  async () => {
    let active = true,
      logged = false
    const service = auditService({
      teamMember: { findFirst: async () => (active ? { id: "member" } : null) },
      teamAccessLog: {
        create: async () => {
          logged = true
        },
      },
    })
    Object.assign(service, {
      approval: {
        verifyTeamEvidence: async () => {
          active = false
        },
      },
    })
    await rejects(
      service.authorizePatternExport(
        TEAM,
        "issuance",
        admin as never,
        {} as never,
      ),
      403,
    )
    assert.equal(logged, false)
  },
)

void run();
