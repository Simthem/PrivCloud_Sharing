import "reflect-metadata";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ConflictException } from "@nestjs/common";
import { User } from "@prisma/client";
import { UserController } from "../src/user/user.controller";
import { UserDTO } from "../src/user/dto/user.dto";
import { UserSevice } from "../src/user/user.service";

void (async () => {
  const updates: Array<Record<string, unknown>> = [];
  let firstUseWriteCount = 1;
  const service = Object.create(UserSevice.prototype) as UserSevice;
  Object.assign(service, {
    prisma: {
      user: {
        update: async (args: { data: Record<string, unknown> }) => {
          updates.push(args.data);
          return args.data;
        },
        updateMany: async (args: { data: Record<string, unknown> }) => {
          if (firstUseWriteCount === 1) updates.push(args.data);
          return { count: firstUseWriteCount };
        },
      },
    },
  });

  await service.removeEncryptionKeyHash("user-1");
  assert.equal(updates[0].encryptionKeyHash, null);
  assert.ok(updates[0].e2eAutoGenerationDisabledAt instanceof Date);

  await service.setEncryptionKeyHash("user-1", "a".repeat(64));
  assert.equal(updates[1].encryptionKeyHash, "a".repeat(64));
  assert.equal(updates[1].e2eAutoGenerationDisabledAt, null);

  firstUseWriteCount = 0;
  await assert.rejects(
    service.setEncryptionKeyHash("user-1", "b".repeat(64)),
    ConflictException,
    "a stale first-use request must not replace concurrent key state",
  );
  await service.setEncryptionKeyHash("user-1", "c".repeat(64), {
    explicitE2ESetup: true,
  });
  assert.equal(updates[2].encryptionKeyHash, "c".repeat(64));

  const optedOutDTO = new UserDTO().from({
    encryptionKeyHash: null,
    e2eAutoGenerationDisabledAt: new Date(),
  });
  assert.equal(optedOutDTO.hasEncryptionKey, false);
  assert.equal(optedOutDTO.e2eAutoGenerationDisabled, true);

  const neverConfiguredDTO = new UserDTO().from({
    encryptionKeyHash: null,
    e2eAutoGenerationDisabledAt: null,
  });
  assert.equal(neverConfiguredDTO.e2eAutoGenerationDisabled, false);

  let registeredHash: string | null = null;
  let registrationWasExplicit = false;
  const controller = Object.create(UserController.prototype) as UserController;
  Object.assign(controller, {
    userService: {
      setEncryptionKeyHash: async (
        _userId: string,
        hash: string,
        options: { explicitE2ESetup?: boolean },
      ) => {
        registeredHash = hash;
        registrationWasExplicit = options.explicitE2ESetup === true;
      },
    },
  });
  const optedOutUser = {
    id: "user-1",
    e2eAutoGenerationDisabledAt: new Date(),
  } as unknown as User;

  await assert.rejects(
    controller.setEncryptionKey(optedOutUser, { keyHash: "b".repeat(64) }),
    ConflictException,
  );
  assert.equal(registeredHash, null);

  await controller.setEncryptionKey(optedOutUser, {
    keyHash: "c".repeat(64),
    explicitE2ESetup: true,
  });
  assert.equal(registeredHash, "c".repeat(64));
  assert.equal(registrationWasExplicit, true);

  registeredHash = null;
  registrationWasExplicit = true;
  await controller.setEncryptionKey(
    { id: "user-2", e2eAutoGenerationDisabledAt: null } as unknown as User,
    { keyHash: "d".repeat(64) },
  );
  assert.equal(
    registeredHash,
    "d".repeat(64),
    "first-use automatic generation must remain available",
  );
  assert.equal(registrationWasExplicit, false);

  const migration = readFileSync(
    path.resolve(
      "prisma/migrations/20260803143000_add_e2e_auto_generation_opt_out/migration.sql",
    ),
    "utf8",
  );
  assert.match(migration, /ADD COLUMN "e2eAutoGenerationDisabledAt" DATETIME/);
  assert.match(migration, /EXISTS\s*\([\s\S]*"isE2EEncrypted" = 1/);
  assert.match(migration, /"Share"\."creatorId" = "User"\."id"/);

  console.log("user E2E preference tests passed");
})();
