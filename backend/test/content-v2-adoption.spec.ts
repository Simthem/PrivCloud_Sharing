import "reflect-metadata";
import { SafeIdPipe } from "src/share/pipe/safeId.pipe";
import {
  assertUploadContentScheme,
  assertSigningResultContent,
} from "src/file/content-scheme.util";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateShareDTO } from "src/share/dto/createShare.dto";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { ShareService } from "src/share/share.service";
import { ConfigService } from "src/config/config.service";
import { FileService } from "src/file/file.service";
import { ShareController } from "src/share/share.controller";
import { ForbiddenException, ConflictException } from "@nestjs/common";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("E2EE adoption");
const owner = { id: "owner", email: "owner@example.test" };
function service(prisma: unknown = {}) {
  const instance = Object.create(ShareService.prototype) as ShareService;
  Object.assign(instance, {
    prisma,
    logger: { log() {}, debug() {}, warn() {} },
  });
  return instance;
}
const wrapped = () => randomBytes(61).toString("base64url");
const share = () => ({
  id: "share",
  isE2EEncrypted: true,
  cryptoScheme: 2,
  wrappedShareKey: wrapped(),
  wrappedShareKeyAlgorithm: "AES-256-GCM/K_MASTER/AAD-SHARE-ID/V1",
});

testCase(
  "v2 enables dedicated share keys and encrypted descriptions without legacy canary flags",
  () => {
    const flags = [
      "SHARE_DEK_V1_READ",
      "SHARE_DEK_V1_WRITE",
      "FILE_META_V1_WRITE",
    ];
    const saved = flags.map((name) => process.env[name]);
    try {
      process.env.SHARE_DEK_V1_READ = "true";
      process.env.SHARE_DEK_V1_WRITE = "false";
      process.env.FILE_META_V1_WRITE = "false";
      const input = { ...share(), fileMetadataScheme: 1 };
      const result = service().resolveCreateCryptoData(
        input as never,
        owner,
        false,
        false,
        undefined,
        true,
      );
      assert.equal(result.cryptoScheme, 2);
      assert.equal(result.wrappedShareKey, input.wrappedShareKey);
      assert.equal(result.fileMetadataScheme, 1);
      assert.throws(
        () =>
          service().resolveCreateCryptoData(
            input as never,
            owner,
            false,
            false,
          ),
        ConflictException,
      );
    } finally {
      flags.forEach((name, index) => {
        if (saved[index] === undefined) delete process.env[name];
        else process.env[name] = saved[index];
      });
    }
  },
);

testCase("team and reverse contexts retain their existing key scheme", () => {
  const input = { id: "share", isE2EEncrypted: true, fileMetadataScheme: 1 };
  const team = service().resolveCreateCryptoData(
    input as never,
    owner,
    false,
    true,
    undefined,
    true,
  );
  const reverse = service().resolveCreateCryptoData(
    input as never,
    undefined,
    true,
    false,
    {
      encryptedReverseShareKey: wrapped(),
      owner,
    },
    true,
  );
  assert.equal(team.cryptoScheme, null);
  assert.equal(reverse.cryptoScheme, null);
  assert.equal(team.fileMetadataScheme, 1);
  assert.equal(reverse.fileMetadataScheme, 1);
});

testCase(
  "v2 file descriptors are accepted inside a historical share without changing its scheme",
  () => {
    const file = {
      id: randomUUID(),
      name: "",
      encryptedMetadata: randomBytes(92).toString("base64url"),
      contentScheme: 2,
    };
    file.name = "encrypted-file-" + file.id.slice(0, 8);
    const instance = Object.create(FileService.prototype) as FileService;
    Object.assign(instance, { logger: { warn() {} } });
    const resolve = (
      instance as unknown as {
        resolveUploadedFile: (
          share: object,
          file: object,
        ) => { metadataScheme: number; encryptedMetadata: string };
      }
    ).resolveUploadedFile.bind(instance);
    const oldShare = { id: "historic", fileMetadataScheme: null };
    const result = resolve(oldShare, file);
    assert.equal(result.metadataScheme, 1);
    assert.equal(result.encryptedMetadata, file.encryptedMetadata);
    assert.equal(oldShare.fileMetadataScheme, null);
    assert.throws(() =>
      resolve(oldShare, { ...file, contentScheme: undefined }),
    );
  },
);

testCase("wrapped dedicated keys are served only to the owner", async () => {
  const material = {
    creatorId: owner.id,
    cryptoScheme: 2,
    wrappedShareKey: wrapped(),
  };
  const controller = Object.create(
    ShareController.prototype,
  ) as ShareController;
  Object.assign(controller, {
    shareService: {
      getEncryptedReverseShareKey: async () => null,
      getWrappedShareKey: async () => material,
    },
    logger: { debug() {} },
  });
  await assert.rejects(
    controller.getEncryptedE2eKey("share", { id: "other" } as never),
    ForbiddenException,
  );
  assert.equal(
    (await controller.getEncryptedE2eKey("share", owner as never))
      .wrappedShareKey,
    material.wrappedShareKey,
  );
});

testCase("new key policy is read freshly on each backend replica", async () => {
  let value = "false";
  const config = Object.create(ConfigService.prototype) as ConfigService;
  Object.assign(config, {
    isEditAllowed: () => true,
    prisma: {
      config: {
        findUnique: async () => ({
          category: "share",
          name: "contentV2Floor",
          defaultValue: "false",
          value,
        }),
      },
    },
  });
  assert.equal(await config.isContentV2FloorEnabled(), false);
  value = "true";
  assert.equal(await config.isContentV2FloorEnabled(), true);
});

testCase(
  "a current context refuses a v1 writer even before the global server switch",
  () => {
    for (const context of [
      { shareId: "v2.new-share", fileId: randomUUID() },
      { shareId: "historic", fileId: "01234567-89ab-8def-89ab-0123456789ab" },
    ]) {
      assert.throws(
        () =>
          assertUploadContentScheme({
            ...context,
            isE2EEncrypted: true,
            v2WritesEnabled: false,
            scheme: undefined,
          }),
        ConflictException,
      );
    }
  },
);

testCase(
  "the reserved share namespace passes DTO validation without permitting path traversal",
  async () => {
    const dto = plainToInstance(CreateShareDTO, {
      id: "v2.new-share",
      expiration: "1-days",
      isE2EEncrypted: true,
      contentScheme: 2,
    });
    const errors = await validate(dto);
    assert.equal(
      errors.some(
        (error) =>
          error.property === "id" || error.property === "contentScheme",
      ),
      false,
    );
    const pipe = new SafeIdPipe();
    assert.equal(pipe.transform("v2.new-share", {} as never), "v2.new-share");
    for (const id of ["abc.def", "v2...", "v2./file", "../file", "v2."])
      assert.throws(() => pipe.transform(id, {} as never));
  },
);

testCase("new signing identities refuse v1 results before storage", () => {
  assert.throws(
    () =>
      assertSigningResultContent(
        "01234567-89ab-8def-89ab-0123456789ab",
        Buffer.alloc(100),
      ),
    ConflictException,
  );
  assert.doesNotThrow(() =>
    assertSigningResultContent("legacy-document", Buffer.alloc(100)),
  );
});

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
