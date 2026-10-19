import "reflect-metadata";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BadRequestException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  CreateAccessGrantDTO,
  GRANT_ALGORITHM_HYBRID,
  GRANT_ALGORITHM_X25519,
} from "src/crypto/dto/crypto.dto";
import { AccessGrantService } from "src/crypto/grant.service";
import { downloadAlertShareName } from "src/downloadNotification/downloadNotification.service";
import {
  isValidEncryptedFileRequestInfo,
  isValidEncryptedReverseShareName,
} from "src/file/file-metadata-scheme";
import { FileService } from "src/file/file.service";
import { CreateReverseShareDTO } from "src/reverseShare/dto/createReverseShare.dto";
import { ReverseShareDTO } from "src/reverseShare/dto/reverseShare.dto";
import { ReverseShareService } from "src/reverseShare/reverseShare.service";
import { auditEmailAnomalyLine } from "src/team/team-audit.util";
import { CreateTeamFileRequestDTO } from "src/teamFileRequest/dto/create-team-file-request.dto";
import { TeamFileRequestService } from "src/teamFileRequest/team-file-request.service";
import {
  TEAM_NOTIFICATION_PUSH_BODY,
  navigationMetadata,
  teamNotificationTitle,
} from "src/teamNotification/team-notification-messages";
import { TeamNotificationService } from "src/teamNotification/teamNotification.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("E2E metadata hardening");

const FILE_ID = "7352aeee-e01b-4dcc-a812-90d9e1647bed";
const REQUEST_ID = "1f0e3c9a-6a43-4b5e-9a57-2c1d6f3b8e10";
const FOLDER_ID = "5a0c2f8e-3b1d-4e6f-8a9b-0c1d2e3f4a5b";
const RECIPIENT_ID = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const KEM = Buffer.alloc(1088, 3).toString("base64url");
const NAMES = /Alice|alice@example\.test|secret-plan\.pdf|Finance/;

// base64url of [IV 12][plaintext padded to `plaintext` bytes][tag 16].
function ciphertext(plaintext: number): string {
  return Buffer.alloc(12 + plaintext + 16, 7).toString("base64url");
}

function withEnv(
  values: Record<string, string>,
  runCase: () => Promise<void>,
): Promise<void> {
  const saved = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  return runCase().finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const errorCode = (code: string) => (error: unknown) =>
  error instanceof BadRequestException &&
  (error.getResponse() as { message?: string }).message === code;

function notificationService() {
  const rows: Record<string, unknown>[] = [];
  const pushes: { title: string; body: string }[] = [];
  const frames: { title: string; body: string }[] = [];
  const service = new TeamNotificationService(
    {
      teamNotification: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          rows.push(data);
          return { id: "notification-1", ...data };
        },
        createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
          rows.push(...data);
        },
      },
      teamMember: {
        findMany: async () => [
          { userId: "member-1", role: "ADMIN", pushNotifMode: "EVERY_FILE" },
        ],
      },
    } as never,
    {
      sendToUser: async (_userId: string, payload: never) => {
        pushes.push(payload);
      },
    } as never,
  );
  return { service, rows, pushes, frames };
}

testCase("team notifications never carry names", async () => {
  const { service, rows, pushes, frames } = notificationService();
  await service.notify({
    type: "FILE_SHARED",
    title: 'Alice a partagé "secret-plan.pdf"',
    teamId: "team-1",
    userId: "member-1",
    metadata: {
      senderName: "Alice",
      fileName: "secret-plan.pdf",
      highlightFileId: FILE_ID,
    },
  });
  await service.notifyTeamMembers("team-1", "actor-1", "FILE_UPLOADED", {
    folderId: FOLDER_ID,
    metadata: { folderName: "Finance", shareId: "share-1" },
  });

  assert.equal(rows[0].title, teamNotificationTitle("FILE_SHARED"));
  assert.equal(rows[0].metadata, JSON.stringify({ highlightFileId: FILE_ID }));
  assert.equal(rows[1].title, teamNotificationTitle("FILE_UPLOADED"));
  assert.equal(rows[1].metadata, JSON.stringify({ shareId: "share-1" }));
  await new Promise((resolve) => setImmediate(resolve));
  for (const payload of [...pushes, ...frames]) {
    assert.equal(payload.body, TEAM_NOTIFICATION_PUSH_BODY);
  }
  assert.doesNotMatch(JSON.stringify({ rows, pushes, frames }), NAMES);
});

testCase("navigation metadata keeps identifiers only", () => {
  assert.equal(navigationMetadata(undefined), undefined);
  assert.equal(navigationMetadata({ fileName: "secret-plan.pdf" }), undefined);
  assert.deepEqual(
    navigationMetadata({
      highlightFileId: FILE_ID,
      signingDocumentId: "doc 1",
      memberName: "Alice",
    }),
    { highlightFileId: FILE_ID },
  );
});

testCase("migration rewrites old notifications with the same texts", () => {
  const sql = readFileSync(
    path.resolve(
      "prisma/migrations/20261002140000_e2e_metadata_hardening/migration.sql",
    ),
    "utf8",
  );
  for (const type of [
    "FILE_SHARED",
    "FILE_UPLOADED",
    "FILE_DELETED",
    "GRANT_RECEIVED",
    "GRANT_REVOKED",
    "KEY_ROTATED",
    "MEMBER_JOINED",
    "MEMBER_LEFT",
  ] as const) {
    assert.ok(
      sql.includes(`WHEN '${type}' THEN '${teamNotificationTitle(type)}'`),
      type,
    );
  }
  assert.match(sql, /WHERE "encryptedMetadata" IS NULL/);
  assert.doesNotMatch(sql, /DELETE FROM/);
});

testCase("audit emails and download alerts name nobody", () => {
  assert.doesNotMatch(
    auditEmailAnomalyLine({
      code: "DOWNLOAD_BURST",
      severity: "WARNING",
      description: "60 téléchargements par alice@example.test sur la période",
    }),
    NAMES,
  );
  assert.equal(
    downloadAlertShareName({ name: "Finance", isE2EEncrypted: true }),
    "Partage chiffré",
  );
  assert.equal(
    downloadAlertShareName({ name: "Finance", isE2EEncrypted: false }),
    "Finance",
  );
});

function grantService(pqKey: boolean) {
  const writes: Record<string, unknown>[] = [];
  const service = new AccessGrantService({
    userIdentityKey: { findFirst: async () => ({ id: "x25519-key" }) },
    userPQKey: { findFirst: async () => (pqKey ? { id: "pq-key" } : null) },
    file: { findUnique: async () => ({ share: { teamFolder: null } }) },
    accessGrant: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push(data);
        return { id: "grant-1", dekVersion: 1 };
      },
    },
  } as never);
  Object.assign(service, {
    validateGrantorAccess: async () => undefined,
    logTeamGrantEvent: async () => undefined,
  });
  return { service, writes };
}

const grant = (extra: Partial<CreateAccessGrantDTO>) =>
  ({
    encryptedFileKey: ciphertext(32),
    ephemeralPublicKey: Buffer.alloc(32).toString("base64url"),
    nonce: Buffer.alloc(12).toString("base64url"),
    recipientUserId: RECIPIENT_ID,
    fileId: FILE_ID,
    ...extra,
  }) as CreateAccessGrantDTO;

testCase("hybrid grants store their ML-KEM ciphertext", async () => {
  const { service, writes } = grantService(true);
  await service.createGrant(
    "grantor-1",
    grant({ algorithm: GRANT_ALGORITHM_HYBRID, kemCiphertext: KEM }),
  );
  assert.equal(writes[0].algorithm, GRANT_ALGORITHM_HYBRID);
  assert.equal(writes[0].kemCiphertext, KEM);

  await service.createGrant("grantor-1", grant({}));
  assert.equal(writes[1].algorithm, GRANT_ALGORITHM_X25519);
  assert.equal(writes[1].kemCiphertext, null);

  await assert.rejects(
    service.createGrant(
      "grantor-1",
      grant({ algorithm: GRANT_ALGORITHM_HYBRID }),
    ),
    BadRequestException,
  );
  await assert.rejects(
    service.createGrant("grantor-1", grant({ kemCiphertext: KEM })),
    BadRequestException,
  );
  await assert.rejects(
    grantService(false).service.createGrant(
      "grantor-1",
      grant({ algorithm: GRANT_ALGORITHM_HYBRID, kemCiphertext: KEM }),
    ),
    BadRequestException,
  );
});

testCase("grant DTO accepts one ML-KEM-768 ciphertext size", async () => {
  const errors = async (extra: Record<string, unknown>) =>
    (
      await validate(
        plainToInstance(CreateAccessGrantDTO, { ...grant({}), ...extra }),
      )
    ).map((error) => error.property);
  assert.deepEqual(
    await errors({ algorithm: GRANT_ALGORITHM_HYBRID, kemCiphertext: KEM }),
    [],
  );
  assert.deepEqual(await errors({ kemCiphertext: KEM.slice(1) }), [
    "kemCiphertext",
  ]);
  assert.deepEqual(await errors({ algorithm: "x25519-ml-kem-768-aes256gcm" }), [
    "algorithm",
  ]);
});

function reverseShareService() {
  const writes: Record<string, unknown>[] = [];
  const service = new ReverseShareService(
    { get: () => 10000 } as never,
    {
      reverseShare: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          writes.push(data);
          return { token: "token-1" };
        },
      },
    } as never,
    {} as never,
  );
  return { service, writes };
}

const reverseShare = (extra: Partial<CreateReverseShareDTO>) =>
  ({
    sendEmailNotification: false,
    maxShareSize: 1000,
    shareExpiration: "1-day",
    maxUseCount: 1,
    simplified: false,
    publicAccess: true,
    ...extra,
  }) as CreateReverseShareDTO;

testCase("upload link names are encrypted only with K_rs", async () => {
  const name = ciphertext(64);
  const { service, writes } = reverseShareService();
  await service.create(
    reverseShare({ encryptedName: name, encryptedReverseShareKey: "wrapped" }),
    "owner-1",
    true,
  );
  assert.equal(writes[0].encryptedName, name);
  assert.equal(writes[0].name, undefined);

  await assert.rejects(
    service.create(
      reverseShare({ encryptedName: name, encryptedReverseShareKey: "w" }),
      "owner-1",
      false,
    ),
    errorCode("reverse_share_name_not_allowed"),
  );
  await assert.rejects(
    service.create(reverseShare({ encryptedName: name }), "owner-1", true),
    errorCode("reverse_share_name_not_allowed"),
  );
  await assert.rejects(
    service.create(
      reverseShare({
        name: "Finance",
        encryptedName: name,
        encryptedReverseShareKey: "w",
      }),
      "owner-1",
      true,
    ),
    errorCode("reverse_share_name_invalid"),
  );
  assert.ok(isValidEncryptedReverseShareName(ciphertext(512)));
  assert.ok(!isValidEncryptedReverseShareName(ciphertext(576)));

  const dto = new ReverseShareDTO().from({
    id: "rs-1",
    encryptedName: name,
    encryptedReverseShareKey: "wrapped",
  } as never);
  assert.equal(dto.encryptedName, name);
});

function fileRequestService() {
  const created: Record<string, unknown>[] = [];
  const member = (userId: string, email: string, wrappedTeamKey: string) => ({
    userId,
    role: "OWNER",
    isActive: true,
    pushNotifMode: "SHARES_ONLY",
    wrappedTeamKey,
    user: { id: userId, username: userId, email },
  });
  const team = {
    id: "team-1",
    members: [
      member("owner-1", "owner@example.test", "wrapped"),
      member(RECIPIENT_ID, "member@example.test", "wrapped"),
    ],
    sharedFolders: [{ id: FOLDER_ID, accessRules: [] }],
  };
  const tx = {
    $queryRaw: async () => [],
    $executeRaw: async () => 1,
    team: { findFirst: async () => team },
    teamKeyRotation: { findFirst: async () => null },
    teamFileRequest: {
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: REQUEST_ID };
      },
    },
    teamNotification: { createManyAndReturn: async () => [] },
    teamAccessLog: { create: async () => undefined },
  };
  const service = new TeamFileRequestService(
    {
      ...tx,
      $transaction: async (run: (client: typeof tx) => unknown) => run(tx),
    } as never,
    { deliverFileRequestNotification() {} } as never,
    { enqueue: async () => undefined } as never,
    { get: () => false } as never,
  );
  return { service, created };
}

const request = (extra: Partial<CreateTeamFileRequestDTO>) =>
  ({
    id: REQUEST_ID,
    folderId: FOLDER_ID,
    subject: "",
    recipientIds: [RECIPIENT_ID],
    recipientScope: "SELECTED",
    notifications: [],
    ...extra,
  }) as CreateTeamFileRequestDTO;

testCase(
  "file request subjects are encrypted behind the Team flag",
  async () => {
    const info = ciphertext(128);
    await withEnv(
      {
        FILE_META_V1_WRITE: "true",
        FILE_META_V1_CANARY_USERS: "owner-1",
        FILE_META_V1_TEAM_WRITE: "true",
      },
      async () => {
        const { service, created } = fileRequestService();
        await service.create(
          "team-1",
          "owner-1",
          request({ encryptedInfo: info }),
        );
        assert.equal(created[0].subject, "");
        assert.equal(created[0].note, null);
        assert.equal(created[0].encryptedInfo, info);

        await assert.rejects(
          service.create(
            "team-1",
            "owner-1",
            request({ subject: "Finance", encryptedInfo: info }),
          ),
          errorCode("file_request_info_invalid"),
        );
        await assert.rejects(
          service.create(
            "team-1",
            "owner-1",
            request({ encryptedInfo: "not-an-envelope" }),
          ),
          errorCode("file_request_info_invalid"),
        );
      },
    );
    await withEnv({ FILE_META_V1_TEAM_WRITE: "false" }, async () => {
      await assert.rejects(
        fileRequestService().service.create(
          "team-1",
          "owner-1",
          request({ encryptedInfo: info }),
        ),
        errorCode("file_request_info_not_allowed"),
      );
    });
    assert.ok(isValidEncryptedFileRequestInfo(ciphertext(16384)));
    assert.ok(!isValidEncryptedFileRequestInfo(ciphertext(16448)));

    const dtoErrors = async (extra: Record<string, unknown>) =>
      (
        await validate(
          plainToInstance(CreateTeamFileRequestDTO, {
            ...request({}),
            ...extra,
          }),
        )
      ).map((error) => error.property);
    assert.deepEqual(await dtoErrors({ encryptedInfo: info }), []);
    assert.deepEqual(await dtoErrors({}), ["subject"]);
  },
);

testCase(
  "signed URLs of E2E files name neither the file nor its type",
  async () => {
    const signed: unknown[][] = [];
    const s3 = {
      getBrowserDirectDownloadPolicy: () => ({
        enabled: true,
        expiresInSeconds: 60,
        partBytes: 8 << 20,
        paidPartBytes: 8 << 20,
        maxBufferBytes: 64 << 20,
        paidMaxBufferBytes: 64 << 20,
        maxConcurrency: 4,
        thresholdBytes: 64 << 20,
      }),
      createBrowserDownloadUrl: async (...args: unknown[]) => {
        signed.push(args);
        return { url: "https://s3.example.test/object", candidates: [] };
      },
    };
    const service = (isE2EEncrypted: boolean) =>
      new FileService(
        {
          file: {
            findFirst: async () => ({
              name: "secret-plan.pdf",
              size: BigInt(10),
              encryptionChunkSize: null,
              share: {
                teamFolderId: null,
                isE2EEncrypted,
                creator: {
                  isAdmin: false,
                  subscription: null,
                  teamMemberships: [],
                },
                reverseShare: null,
              },
            }),
          },
        } as never,
        {} as never,
        s3 as never,
        {} as never,
      );

    const e2e = await service(true).authorizeBrowserDownload(
      "share-1",
      FILE_ID,
      "S3",
      false,
    );
    assert.deepEqual(signed[0].slice(2), [
      FILE_ID,
      true,
      "application/octet-stream",
    ]);
    assert.equal(
      (e2e as { contentType?: string }).contentType,
      "application/pdf",
    );

    await service(false).authorizeBrowserDownload(
      "share-1",
      FILE_ID,
      "S3",
      false,
    );
    assert.deepEqual(signed[1].slice(2), [
      "secret-plan.pdf",
      false,
      "application/pdf",
    ]);
  },
);

void run();
