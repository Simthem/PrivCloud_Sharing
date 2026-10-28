import "reflect-metadata";
import assert from "node:assert/strict";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { FileDTO } from "src/file/dto/file.dto";
import {
  FILE_META_V1,
  encryptedFilePlaceholderName,
  isFileMetaWriteEnabledFor,
  isReverseShareFileMetaWriteEnabledFor,
  isTeamFileMetaWriteEnabledFor,
  isValidEncryptedMetadata,
  resolveUploadFileMetadata,
} from "src/file/file-metadata-scheme";
import { FileController } from "src/file/file.controller";
import { FileService } from "src/file/file.service";
import { CreateShareDTO } from "src/share/dto/createShare.dto";
import { ShareDTO } from "src/share/dto/share.dto";
import {
  SHARE_DEK_V1,
  SHARE_KEY_WRAP_ALGORITHM,
} from "src/share/share-crypto-scheme";
import { ShareService } from "src/share/share.service";
import { SigningService } from "src/signing/signing.service";
import {
  databaseWithMigrations,
  migrationStatements,
} from "./sqlite-migration.util";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("FILE_META_V1");

const owner = { id: "owner-1", email: "owner@example.test" };
const FILE_ID = "7352aeee-e01b-4dcc-a812-90d9e1647bed";
const PLACEHOLDER = encryptedFilePlaceholderName(FILE_ID);
const FLAG_KEYS = [
  "SHARE_DEK_V1_READ",
  "SHARE_DEK_V1_WRITE",
  "SHARE_DEK_V1_CANARY_USERS",
  "SHARE_DEK_V1_ROLLOUT_PERCENT",
  "FILE_META_V1_WRITE",
  "FILE_META_V1_CANARY_USERS",
  "FILE_META_V1_ROLLOUT_PERCENT",
  "FILE_META_V1_TEAM_WRITE",
  "FILE_META_V1_REVERSE_SHARE_WRITE",
];
const DEK_FLAGS = {
  SHARE_DEK_V1_WRITE: "true",
  SHARE_DEK_V1_CANARY_USERS: "owner-1",
};

// base64url of [IV 12][plaintext padded to `plaintext` bytes][tag 16].
function ciphertext(plaintext: number): string {
  return Buffer.alloc(12 + plaintext + 16, 7).toString("base64url");
}

function withFlags(
  flags: Record<string, string>,
  runCase: () => void | Promise<void>,
): void | Promise<void> {
  const saved = Object.fromEntries(FLAG_KEYS.map((k) => [k, process.env[k]]));
  for (const key of FLAG_KEYS) delete process.env[key];
  Object.assign(process.env, flags);
  const restore = () => {
    for (const key of FLAG_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
  try {
    const result = runCase();
    if (result instanceof Promise) return result.finally(restore);
    restore();
  } catch (error) {
    restore();
    throw error;
  }
}

function shareService() {
  const instance = Object.create(ShareService.prototype) as ShareService;
  Object.assign(instance, {
    prisma: {},
    logger: { log() {}, warn() {}, debug() {}, error() {} },
  });
  return instance;
}

const dekShare = {
  id: "s1",
  isE2EEncrypted: true,
  cryptoScheme: SHARE_DEK_V1,
  wrappedShareKey: "A".repeat(80),
  wrappedShareKeyAlgorithm: SHARE_KEY_WRAP_ALGORITHM,
} as CreateShareDTO;

testCase("ciphertext format: padded blocks of 64 bytes, 4096 at most", () => {
  assert.equal(isValidEncryptedMetadata(ciphertext(64)), true);
  assert.equal(isValidEncryptedMetadata(ciphertext(128)), true);
  assert.equal(isValidEncryptedMetadata(ciphertext(4096)), true);
  for (const value of [
    ciphertext(0),
    ciphertext(63),
    ciphertext(65),
    ciphertext(4096 + 64),
    `${ciphertext(64)}=`,
    ciphertext(64).replace(/.$/, "+"),
    `${ciphertext(64)}A`,
    "",
    undefined,
    42,
  ]) {
    assert.equal(isValidEncryptedMetadata(value), false, String(value));
  }
  // The largest value still fits in one request header line.
  assert.ok(ciphertext(4096).length < 6000);
});

testCase("an encrypted share accepts nothing readable", () => {
  const encrypted = ciphertext(64);
  assert.deepEqual(
    resolveUploadFileMetadata(FILE_META_V1, {
      id: FILE_ID,
      name: PLACEHOLDER,
      encryptedMetadata: encrypted,
    }),
    {
      name: PLACEHOLDER,
      relativePath: undefined,
      metadataScheme: FILE_META_V1,
      encryptedMetadata: encrypted,
    },
  );
  for (const file of [
    { id: FILE_ID, name: "contract.pdf", encryptedMetadata: encrypted },
    {
      id: FILE_ID,
      name: PLACEHOLDER,
      relativePath: `folder/${PLACEHOLDER}`,
      encryptedMetadata: encrypted,
    },
    { id: FILE_ID, name: PLACEHOLDER },
    { id: FILE_ID, name: PLACEHOLDER, encryptedMetadata: "short" },
    // No client id, or a placeholder that belongs to another file.
    { name: PLACEHOLDER, encryptedMetadata: encrypted },
    {
      id: FILE_ID,
      name: encryptedFilePlaceholderName("00000000-0000"),
      encryptedMetadata: encrypted,
    },
  ]) {
    assert.throws(
      () => resolveUploadFileMetadata(FILE_META_V1, file),
      (error: unknown) =>
        error instanceof BadRequestException &&
        (error.getResponse() as { error?: string }).error ===
          "file_metadata_required",
    );
  }
});

testCase("a plain share keeps its names and refuses ciphertext", () => {
  assert.deepEqual(
    resolveUploadFileMetadata(null, {
      name: "a.txt",
      relativePath: "dir/a.txt",
    }),
    {
      name: "a.txt",
      relativePath: "dir/a.txt",
      metadataScheme: null,
      encryptedMetadata: null,
    },
  );
  assert.throws(
    () =>
      resolveUploadFileMetadata(null, {
        name: PLACEHOLDER,
        encryptedMetadata: ciphertext(64),
      }),
    (error: unknown) =>
      error instanceof BadRequestException &&
      (error.getResponse() as { error?: string }).error ===
        "file_metadata_not_allowed",
  );
  assert.throws(
    () => resolveUploadFileMetadata(2, { name: "a.txt" }),
    BadRequestException,
  );
});

testCase("upload resolution stores the placeholder and no folder path", () => {
  const warnings: string[] = [];
  const service = Object.assign(Object.create(FileService.prototype), {
    logger: { warn: (line: string) => warnings.push(line) },
  }) as {
    resolveUploadedFile: (
      share: { id: string; fileMetadataScheme: number | null },
      file: {
        id: string;
        name: string;
        relativePath?: string;
        encryptedMetadata?: string;
      },
    ) => unknown;
  };
  const encrypted = ciphertext(128);
  assert.deepEqual(
    service.resolveUploadedFile(
      { id: "s1", fileMetadataScheme: FILE_META_V1 },
      {
        id: FILE_ID,
        name: PLACEHOLDER,
        encryptedMetadata: encrypted,
      },
    ),
    {
      id: FILE_ID,
      name: PLACEHOLDER,
      relativePath: undefined,
      metadataScheme: FILE_META_V1,
      encryptedMetadata: encrypted,
    },
  );
  // Plain names still go through the historical path checks.
  assert.deepEqual(
    service.resolveUploadedFile(
      { id: "s1", fileMetadataScheme: null },
      {
        id: "f2",
        name: "b.pdf",
        relativePath: "docs/b.pdf",
      },
    ),
    {
      id: "f2",
      name: "b.pdf",
      relativePath: "docs/b.pdf",
      metadataScheme: null,
      encryptedMetadata: null,
    },
  );
  assert.throws(
    () =>
      service.resolveUploadedFile(
        { id: "s1", fileMetadataScheme: null },
        {
          id: "f3",
          name: "../b.pdf",
        },
      ),
    BadRequestException,
  );
  // A refused upload is logged, never with the name it carried.
  assert.throws(
    () =>
      service.resolveUploadedFile(
        { id: "s1", fileMetadataScheme: FILE_META_V1 },
        { id: FILE_ID, name: "Secret-Dupont.pdf" },
      ),
    BadRequestException,
  );
  assert.deepEqual(warnings, [
    "Upload file name refused: share=redacted reason=file_metadata_required",
  ]);
});

testCase("write flag is off by default and needs SHARE_DEK_V1 too", () => {
  withFlags({}, () => assert.equal(isFileMetaWriteEnabledFor(owner), false));
  withFlags(
    { FILE_META_V1_WRITE: "true", FILE_META_V1_CANARY_USERS: "*" },
    () => assert.equal(isFileMetaWriteEnabledFor(owner), false),
  );
  withFlags({ ...DEK_FLAGS, FILE_META_V1_WRITE: "true" }, () =>
    assert.equal(isFileMetaWriteEnabledFor(owner), false),
  );
  withFlags(
    {
      ...DEK_FLAGS,
      FILE_META_V1_WRITE: "true",
      FILE_META_V1_CANARY_USERS: "OWNER@example.test",
    },
    () => {
      assert.equal(isFileMetaWriteEnabledFor(owner), true);
      assert.equal(isFileMetaWriteEnabledFor(undefined), false);
    },
  );
  withFlags(
    {
      ...DEK_FLAGS,
      FILE_META_V1_WRITE: "false",
      FILE_META_V1_CANARY_USERS: "*",
    },
    () => assert.equal(isFileMetaWriteEnabledFor(owner), false),
  );
});

testCase("rollout percentage uses its own stable bucket", () =>
  withFlags(
    {
      SHARE_DEK_V1_WRITE: "true",
      SHARE_DEK_V1_CANARY_USERS: "*",
      FILE_META_V1_WRITE: "true",
      FILE_META_V1_ROLLOUT_PERCENT: "50",
    },
    () => {
      const users = Array.from({ length: 400 }, (_, i) => ({ id: `u${i}` }));
      const selected = users.filter((u) => isFileMetaWriteEnabledFor(u));
      assert.ok(selected.length > 120 && selected.length < 280);
      assert.deepEqual(
        users.filter((u) => isFileMetaWriteEnabledFor(u)),
        selected,
      );
    },
  ),
);

testCase("share creation: FILE_META_V1 only on top of SHARE_DEK_V1", () => {
  const request = { ...dekShare, fileMetadataScheme: FILE_META_V1 };
  withFlags(DEK_FLAGS, () => {
    assert.throws(
      () =>
        shareService().resolveCreateCryptoData(
          request as CreateShareDTO,
          owner as never,
          false,
          false,
        ),
      (error: unknown) =>
        error instanceof ConflictException &&
        (error.getResponse() as { error?: string }).error ===
          "file_metadata_scheme_unavailable",
    );
  });
  withFlags(
    {
      ...DEK_FLAGS,
      FILE_META_V1_WRITE: "true",
      FILE_META_V1_CANARY_USERS: "*",
    },
    () => {
      assert.equal(
        shareService().resolveCreateCryptoData(
          request as CreateShareDTO,
          owner as never,
          false,
          false,
        ).fileMetadataScheme,
        FILE_META_V1,
      );
      assert.equal(
        shareService().resolveCreateCryptoData(
          dekShare,
          owner as never,
          false,
          false,
        ).fileMetadataScheme,
        null,
      );
      for (const input of [
        { id: "s1", isE2EEncrypted: true, fileMetadataScheme: FILE_META_V1 },
        {
          id: "s1",
          isE2EEncrypted: true,
          cryptoScheme: 1,
          fileMetadataScheme: FILE_META_V1,
        },
        { ...dekShare, fileMetadataScheme: 2 },
      ]) {
        assert.throws(
          () =>
            shareService().resolveCreateCryptoData(
              input as CreateShareDTO,
              owner as never,
              false,
              false,
            ),
          BadRequestException,
        );
      }
    },
  );
});

testCase("create DTO accepts FILE_META_V1 only", async () => {
  const base = { id: "abc", expiration: "never", security: {} };
  const ok = plainToInstance(CreateShareDTO, {
    ...base,
    fileMetadataScheme: FILE_META_V1,
  });
  assert.equal(
    (await validate(ok)).some((e) => e.property === "fileMetadataScheme"),
    false,
  );
  for (const value of [0, 2, "1", true]) {
    const bad = plainToInstance(CreateShareDTO, {
      ...base,
      fileMetadataScheme: value,
    });
    assert.equal(
      (await validate(bad)).some((e) => e.property === "fileMetadataScheme"),
      true,
      String(value),
    );
  }
});

testCase("DTOs expose the scheme and ciphertext to the key holder", () => {
  const encrypted = ciphertext(64);
  const file = new FileDTO().from({
    id: "f1",
    name: PLACEHOLDER,
    size: "10",
    metadataScheme: FILE_META_V1,
    encryptedMetadata: encrypted,
  });
  assert.equal(file.metadataScheme, FILE_META_V1);
  assert.equal(file.encryptedMetadata, encrypted);
  const share = new ShareDTO().from({
    id: "s1",
    fileMetadataScheme: FILE_META_V1,
  } as never);
  assert.equal(share.fileMetadataScheme, FILE_META_V1);
});

testCase(
  "signing an encrypted file needs the name from its owner",
  async () => {
    const signing = Object.create(SigningService.prototype) as SigningService;
    Object.assign(signing, {
      configService: { get: () => true },
      prisma: {
        share: {
          findFirst: async () => ({
            id: "s1",
            files: [
              {
                id: "f1",
                name: PLACEHOLDER,
                metadataScheme: FILE_META_V1,
              },
            ],
          }),
        },
      },
    });
    const dto = { shareId: "s1", fileId: "f1", recipients: [] };
    for (const documentName of [undefined, "notes.txt", "../x.pdf"]) {
      await assert.rejects(
        signing.createSignatureRequest(
          { ...dto, documentName } as never,
          owner as never,
        ),
        BadRequestException,
        String(documentName),
      );
    }
  },
);

testCase("migration is additive and pins the placeholder name", () => {
  const migration = "20260930120000_add_file_meta_v1";
  const statements = migrationStatements(migration);
  // Triggers stand in for CHECK constraints: no stored row is rewritten.
  assert.doesNotMatch(
    statements.replace(/BEFORE UPDATE OF/g, ""),
    /\bDROP\b|\bRENAME\b|\bUPDATE\b|\bDELETE\b/i,
  );
  const addedColumns = statements
    .split("\n")
    .filter((line) => line.includes("ADD COLUMN"));
  assert.equal(addedColumns.length, 3);
  for (const line of addedColumns) {
    assert.doesNotMatch(line, /NOT NULL|DEFAULT/i, "new columns stay nullable");
  }
  assert.ok(
    statements.includes(
      `NEW."name" IS ('encrypted-file-' || substr(NEW."id", 1, 8))`,
    ),
  );
  assert.equal(PLACEHOLDER, `encrypted-file-${FILE_ID.slice(0, 8)}`);

  const db = databaseWithMigrations(
    "20260929120000_add_share_dek_v1",
    migration,
  );
  const wrapped = "A".repeat(80);
  const share = db.prepare(
    `INSERT INTO "Share" ("id", "isE2EEncrypted", "cryptoScheme", "wrappedShareKey", "wrappedShareKeyAlgorithm", "wrappedShareKeyVersion", "fileMetadataScheme") VALUES (?, 1, ?, ?, ?, ?, ?)`,
  );
  share.run("legacy", null, null, null, null, null);
  share.run(
    "encrypted",
    SHARE_DEK_V1,
    wrapped,
    SHARE_KEY_WRAP_ALGORITHM,
    1,
    FILE_META_V1,
  );
  assert.throws(
    () => share.run("legacy-names", null, null, null, null, FILE_META_V1),
    /Share\.fileMetadataScheme/,
  );
  assert.throws(
    () =>
      db
        .prepare(
          `UPDATE "Share" SET "fileMetadataScheme" = 1 WHERE "id" = 'legacy'`,
        )
        .run(),
    /Share\.fileMetadataScheme/,
  );

  const file = db.prepare(
    `INSERT INTO "File" ("id", "name", "relativePath", "shareId", "metadataScheme", "encryptedMetadata") VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const encrypted = ciphertext(64);
  file.run("plain-file", "report.pdf", "folder/sub", "legacy", null, null);
  file.run(FILE_ID, PLACEHOLDER, null, "encrypted", FILE_META_V1, encrypted);
  const otherId = "0f1e2d3c-4b5a-4968-8776-655443322110";
  const otherPlaceholder = encryptedFilePlaceholderName(otherId);
  for (const [name, relativePath, scheme, metadata] of [
    ["report.pdf", null, FILE_META_V1, encrypted],
    [PLACEHOLDER, null, FILE_META_V1, encrypted],
    [otherPlaceholder, "folder", FILE_META_V1, encrypted],
    [otherPlaceholder, null, null, encrypted],
    [otherPlaceholder, null, FILE_META_V1, null],
  ]) {
    assert.throws(
      () =>
        file.run(otherId, name, relativePath, "encrypted", scheme, metadata),
      /File\.encryptedMetadata/,
      `${name} ${relativePath} ${scheme}`,
    );
  }
  // An encrypted row can never be given a readable name afterwards.
  assert.throws(
    () =>
      db
        .prepare(`UPDATE "File" SET "name" = 'report.pdf' WHERE "id" = ?`)
        .run(FILE_ID),
    /File\.encryptedMetadata/,
  );
  db.prepare(
    `UPDATE "File" SET "name" = 'renamed.pdf' WHERE "id" = 'plain-file'`,
  ).run();
  db.close();
});

const SELECTED = { FILE_META_V1_WRITE: "true", FILE_META_V1_CANARY_USERS: "*" };
const unavailable = (error: unknown) =>
  error instanceof ConflictException &&
  (error.getResponse() as { error?: string }).error ===
    "file_metadata_scheme_unavailable";

testCase("Team uploads encrypt names with K_team behind their own flag", () => {
  const teamUpload = {
    id: "t1",
    isE2EEncrypted: true,
    fileMetadataScheme: FILE_META_V1,
  } as CreateShareDTO;
  const resolve = (request: CreateShareDTO) =>
    shareService().resolveCreateCryptoData(
      request,
      owner as never,
      false,
      true,
    );

  withFlags({}, () => assert.throws(() => resolve(teamUpload), unavailable));
  // Personal selection alone does not reach Team folders.
  withFlags(SELECTED, () => {
    assert.equal(isTeamFileMetaWriteEnabledFor(owner), false);
    assert.throws(() => resolve(teamUpload), unavailable);
  });
  withFlags({ ...SELECTED, FILE_META_V1_TEAM_WRITE: "true" }, () => {
    assert.equal(isTeamFileMetaWriteEnabledFor(owner), true);
    const data = resolve(teamUpload);
    assert.equal(data.fileMetadataScheme, FILE_META_V1);
    // K_team stays the content key: no personal key scheme is recorded.
    assert.equal(data.cryptoScheme, null);
    assert.throws(
      () => resolve({ ...teamUpload, isE2EEncrypted: false }),
      BadRequestException,
    );
  });
  withFlags(
    { FILE_META_V1_WRITE: "true", FILE_META_V1_TEAM_WRITE: "true" },
    () => assert.throws(() => resolve(teamUpload), unavailable),
  );
});

testCase("reverse-share uploads follow the owner's selection", () => {
  const upload = {
    id: "r1",
    isE2EEncrypted: true,
    fileMetadataScheme: FILE_META_V1,
  } as CreateShareDTO;
  const reverseShare = {
    encryptedReverseShareKey: "wrapped-k-rs",
    owner,
  };
  const resolve = (
    request: CreateShareDTO,
    rs:
      | typeof reverseShare
      | { encryptedReverseShareKey: null; owner: typeof owner },
  ) =>
    // The uploader is anonymous: only the owner decides.
    shareService().resolveCreateCryptoData(request, undefined, true, false, rs);

  withFlags(SELECTED, () =>
    assert.throws(() => resolve(upload, reverseShare), unavailable),
  );
  withFlags({ ...SELECTED, FILE_META_V1_REVERSE_SHARE_WRITE: "true" }, () => {
    assert.equal(isReverseShareFileMetaWriteEnabledFor(owner), true);
    assert.equal(
      resolve(upload, reverseShare).fileMetadataScheme,
      FILE_META_V1,
    );
    // A reverse share without K_rs has no key that could hide the names.
    assert.throws(
      () => resolve(upload, { encryptedReverseShareKey: null, owner }),
      BadRequestException,
    );
    assert.throws(
      () => resolve({ ...upload, isE2EEncrypted: false }, reverseShare),
      BadRequestException,
    );
  });
});

testCase(
  "an encrypted title replaces the readable title and description",
  () => {
    const personal = { ...dekShare, fileMetadataScheme: FILE_META_V1 };
    const resolve = (request: Partial<CreateShareDTO>) =>
      shareService().resolveCreateCryptoData(
        request as CreateShareDTO,
        owner as never,
        false,
        false,
      );
    withFlags({ ...DEK_FLAGS, ...SELECTED }, () => {
      const info = ciphertext(128);
      assert.equal(
        resolve({ ...personal, encryptedInfo: info }).encryptedInfo,
        info,
      );
      assert.equal(resolve(personal).encryptedInfo, null);
      for (const request of [
        { ...personal, encryptedInfo: info, name: "Contrat" },
        { ...personal, encryptedInfo: info, description: "Signé" },
        { ...personal, encryptedInfo: "not base64url!" },
        { ...personal, encryptedInfo: ciphertext(70) },
        { ...dekShare, encryptedInfo: info },
      ]) {
        assert.throws(() => resolve(request), BadRequestException);
      }
    });
  },
);

testCase("create and read DTOs carry the encrypted title", async () => {
  const base = {
    id: "abc",
    expiration: "never",
    security: {},
    fileMetadataScheme: FILE_META_V1,
  };
  const dto = plainToInstance(CreateShareDTO, {
    ...base,
    encryptedInfo: ciphertext(64),
  });
  assert.deepEqual(await validate(dto), []);
  const tooLong = plainToInstance(CreateShareDTO, {
    ...base,
    encryptedInfo: "A".repeat(6001),
  });
  assert.equal((await validate(tooLong)).length > 0, true);
  const exposed = new ShareDTO().from({
    id: "abc",
    fileMetadataScheme: FILE_META_V1,
    encryptedInfo: ciphertext(64),
  } as never);
  assert.equal(exposed.encryptedInfo, ciphertext(64));
  assert.equal(exposed.name, undefined);
});

testCase(
  "Team key rotation rewrites an encrypted name with the last chunk",
  async () => {
    const updates: unknown[] = [];
    const separateUpdates: unknown[] = [];
    const controller = (metadataScheme: number | null) => {
      const instance = Object.create(
        FileController.prototype,
      ) as FileController;
      Object.assign(instance, {
        prisma: {
          share: { findUnique: async () => ({ cryptoScheme: null }) },
          file: {
            findFirst: async () => ({ metadataScheme }),
            update: async (args: unknown) => separateUpdates.push(args),
          },
        },
        fileService: {
          replaceFileContent: async (...args: unknown[]) => {
            if (args[7] !== undefined) updates.push(args[7]);
          },
        },
        logger: { log() {}, warn() {}, debug() {}, error() {} },
      });
      return instance;
    };
    const chunk = (index: number, total: number) => ({
      chunkIndex: String(index),
      totalChunks: String(total),
    });
    const body = Buffer.alloc(16);
    const name = ciphertext(64);
    const call = (
      instance: FileController,
      index: number,
      total: number,
      header?: string,
    ) =>
      instance.reencrypt(
        chunk(index, total),
        body,
        "share-1",
        FILE_ID,
        {} as never,
        header,
      );

    const errorCode = (code: string) => (error: unknown) =>
      error instanceof BadRequestException &&
      (error.getResponse() as { error?: string }).error === code;

    await assert.rejects(
      call(controller(FILE_META_V1), 1, 2),
      errorCode("file_metadata_required"),
    );
    await assert.rejects(
      call(controller(null), 0, 1, name),
      errorCode("file_metadata_not_allowed"),
    );
    await call(controller(FILE_META_V1), 0, 2);
    assert.equal(updates.length, 0, "intermediate chunks keep the old name");
    await call(controller(FILE_META_V1), 1, 2, name);
    assert.deepEqual(updates, [name]);
    assert.equal(
      separateUpdates.length,
      0,
      "the description is committed with the content",
    );
    await call(controller(null), 0, 1);
    assert.equal(updates.length, 1, "v1 rotations retain plain names");
    await controller(null).reencrypt(
      { ...chunk(0, 1), contentScheme: "2", encryptionChunkSize: "1000000" },
      Buffer.alloc(60),
      "share-1",
      FILE_ID,
      {} as never,
      name,
    );
    assert.deepEqual(
      updates,
      [name, name],
      "a v2 rotation can authenticate a historical plain name",
    );
  },
);

testCase("extension migration keeps LEGACY shares out with triggers", () => {
  const migration = "20261002120000_extend_file_meta_v1";
  const statements = migrationStatements(migration);
  // Only the previous FILE_META_V1 triggers are replaced, no row is rewritten.
  const dropped = statements.match(/DROP TRIGGER "[^"]+"/g) ?? [];
  assert.deepEqual(dropped, [
    'DROP TRIGGER "Share_fileMetadataScheme_check_insert"',
    'DROP TRIGGER "Share_fileMetadataScheme_check_update"',
  ]);
  assert.doesNotMatch(
    statements.replace(/DROP TRIGGER/g, "").replace(/BEFORE UPDATE OF/g, ""),
    /\bDROP\b|\bRENAME\b|\bUPDATE\b|\bDELETE\b|NOT NULL|DEFAULT/i,
  );

  const db = databaseWithMigrations(
    "20260929120000_add_share_dek_v1",
    "20260930120000_add_file_meta_v1",
    migration,
  );
  const share = db.prepare(
    `INSERT INTO "Share" ("id", "isE2EEncrypted", "cryptoScheme", "fileMetadataScheme", "encryptedInfo", "name", "description") VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = ciphertext(64);
  // Team and reverse-share uploads keep a NULL personal key scheme.
  share.run("team", 1, null, FILE_META_V1, null, null, null);
  share.run("team-title", 1, null, FILE_META_V1, info, null, null);
  for (const [id, e2e, scheme, names, encryptedInfo, name, description] of [
    ["legacy", 1, 1, FILE_META_V1, null, null, null],
    ["plain", 0, null, FILE_META_V1, null, null, null],
    ["title-without-names", 1, null, null, info, null, null],
    ["title-and-name", 1, null, FILE_META_V1, info, "Contrat", null],
    ["title-and-description", 1, null, FILE_META_V1, info, null, "Bilan"],
  ]) {
    assert.throws(
      () => share.run(id, e2e, scheme, names, encryptedInfo, name, description),
      /Share\.(fileMetadataScheme|encryptedInfo)/,
      String(id),
    );
  }
  assert.throws(
    () =>
      db
        .prepare(
          `UPDATE "Share" SET "name" = 'Contrat' WHERE "id" = 'team-title'`,
        )
        .run(),
    /Share\.encryptedInfo/,
  );
  assert.throws(
    () =>
      db
        .prepare(`UPDATE "Share" SET "cryptoScheme" = 1 WHERE "id" = 'team'`)
        .run(),
    /Share\.fileMetadataScheme/,
  );
  db.close();
});

void run();
