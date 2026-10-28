import "reflect-metadata";
import assert from "node:assert/strict";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { BridgeUploadTokenService } from "src/bridgeUpload/bridge-upload-token.service";
import { createUnitTestRunner } from "./unit-test";

const { testCase, run } = createUnitTestRunner("Bridge upload token");

type ShareRecord = {
  id: string;
  creatorId: string | null;
  uploadLocked: boolean;
  teamFolderId?: string;
};

type TokenRecord = {
  id: string;
  tokenHash: string;
  expiresAt: Date;
  creatorId: string;
  label?: string;
  shareId: string;
  revokedAt: Date | null;
  usedAt: Date | null;
};

type CreateTokenArgs = {
  data: {
    tokenHash: string;
    expiresAt: Date;
    creator: { connect: { id: string } };
    label?: string;
    share: { connect: { id: string } };
  };
};

const createHarness = () => {
  const shares = new Map<string, ShareRecord>([
    ["share-1", { id: "share-1", creatorId: "owner-1", uploadLocked: false }],
  ]);
  const records: TokenRecord[] = [
    {
      id: "expired-old",
      tokenHash: "expired",
      expiresAt: new Date(Date.now() - 10_000),
      creatorId: "owner-1",
      label: "old",
      shareId: "share-1",
      revokedAt: null,
      usedAt: null,
    },
  ];

  const prisma = {
    share: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        shares.get(where.id) ?? null,
    },
    bridgeUploadToken: {
      deleteMany: async ({ where }: { where: { expiresAt: { lt: Date } } }) => {
        let deleted = 0;
        for (let index = records.length - 1; index >= 0; index--) {
          if (records[index].expiresAt < where.expiresAt.lt) {
            records.splice(index, 1);
            deleted++;
          }
        }
        return { count: deleted };
      },
      create: async ({ data }: CreateTokenArgs) => {
        const record: TokenRecord = {
          id: `token-${records.length + 1}`,
          tokenHash: data.tokenHash,
          expiresAt: data.expiresAt,
          creatorId: data.creator.connect.id,
          label: data.label,
          shareId: data.share.connect.id,
          revokedAt: null,
          usedAt: null,
        };
        records.push(record);
        return record;
      },
      findUnique: async ({ where }: { where: { tokenHash: string } }) => {
        const record = records.find(
          (item) => item.tokenHash === where.tokenHash,
        );
        if (!record) return null;
        const share = shares.get(record.shareId);
        return {
          ...record,
          share: {
            id: record.shareId,
            uploadLocked: share?.uploadLocked ?? false,
            creatorId: share?.creatorId ?? null,
            teamFolderId: share?.teamFolderId ?? null,
          },
        };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<TokenRecord>;
      }) => {
        const record = records.find((item) => item.id === where.id);
        if (!record) throw new Error("Token not found");
        Object.assign(record, data);
        return record;
      },
    },
  };

  // The real rule lives in TeamShareAccessService: here, who has lost it.
  const withoutWriteAccess = new Set<string>();
  const teamChecks: string[] = [];
  const teamShareAccess = {
    assertCanManageShare: async (shareId: string, user: { id: string }) => {
      teamChecks.push(`${shareId}:${user.id}`);
      if (withoutWriteAccess.has(user.id)) {
        throw new ForbiddenException("You do not have write access");
      }
    },
  };

  return {
    service: new BridgeUploadTokenService(
      prisma as never,
      teamShareAccess as never,
    ),
    shares,
    records,
    withoutWriteAccess,
    teamChecks,
  };
};

testCase(
  "creates opaque owner-scoped tokens and stores only hashes",
  async () => {
    const { service, records } = createHarness();
    const before = Date.now() + 12 * 60 * 60 * 1000 - 2_000;
    const longLabel = "x".repeat(200);

    const result = await service.createToken("share-1", "owner-1", longLabel);
    const after = Date.now() + 12 * 60 * 60 * 1000 + 2_000;

    assert.match(result.token, /^pcbu_[A-Za-z0-9_-]+$/);
    assert.ok(result.expiresAt.getTime() >= before);
    assert.ok(result.expiresAt.getTime() <= after);
    assert.equal(records.length, 1, "expired tokens are pruned before create");
    assert.notEqual(records[0].tokenHash, result.token);
    assert.equal(records[0].tokenHash.length, 64);
    assert.equal(records[0].label?.length, 120);
  },
);

testCase(
  "rejects token creation for missing, locked, anonymous or foreign shares",
  async () => {
    const { service, shares } = createHarness();

    await assert.rejects(
      () => service.createToken("missing", "owner-1"),
      NotFoundException,
    );

    shares.set("locked", {
      id: "locked",
      creatorId: "owner-1",
      uploadLocked: true,
    });
    await assert.rejects(
      () => service.createToken("locked", "owner-1"),
      BadRequestException,
    );

    shares.set("anonymous", {
      id: "anonymous",
      creatorId: null,
      uploadLocked: false,
    });
    await assert.rejects(
      () => service.createToken("anonymous", "owner-1"),
      ForbiddenException,
    );

    await assert.rejects(
      () => service.createToken("share-1", "intruder"),
      ForbiddenException,
    );
  },
);

testCase("validates live tokens and records usage", async () => {
  const { service, records } = createHarness();
  const { token } = await service.createToken("share-1", "owner-1");

  await service.validateToken("share-1", token);

  assert.ok(records[0].usedAt instanceof Date);
});

testCase("rejects malformed and wrong-share tokens", async () => {
  const { service } = createHarness();
  const { token } = await service.createToken("share-1", "owner-1");

  await assert.rejects(
    () => service.validateToken("share-1", "bad-token"),
    UnauthorizedException,
  );
  await assert.rejects(
    () => service.validateToken("other-share", token),
    UnauthorizedException,
  );
});

testCase("rejects revoked tokens", async () => {
  const { service, records } = createHarness();
  const { token } = await service.createToken("share-1", "owner-1");
  records[0].revokedAt = new Date();

  await assert.rejects(
    () => service.validateToken("share-1", token),
    UnauthorizedException,
  );
});

testCase("rejects expired tokens", async () => {
  const { service, records } = createHarness();
  const { token } = await service.createToken("share-1", "owner-1");
  records[0].expiresAt = new Date(Date.now() - 1);

  await assert.rejects(
    () => service.validateToken("share-1", token),
    UnauthorizedException,
  );
});

testCase(
  "rejects valid tokens once the target share is completed",
  async () => {
    const { service, shares } = createHarness();
    const { token } = await service.createToken("share-1", "owner-1");
    shares.get("share-1")!.uploadLocked = true;

    await assert.rejects(
      () => service.validateToken("share-1", token),
      BadRequestException,
    );
  },
);

testCase(
  "a Team share token stops working once its creator loses write access",
  async () => {
    const { service, shares, withoutWriteAccess, teamChecks } = createHarness();
    shares.get("share-1")!.teamFolderId = "folder-1";
    const { token } = await service.createToken("share-1", "owner-1");

    await service.validateToken("share-1", token);
    withoutWriteAccess.add("owner-1");

    await assert.rejects(
      () => service.validateToken("share-1", token),
      ForbiddenException,
    );
    assert.deepEqual(teamChecks, ["share-1:owner-1", "share-1:owner-1"]);
  },
);

testCase(
  "a token stops working once its creator no longer owns the share",
  async () => {
    const { service, shares, teamChecks } = createHarness();
    const { token } = await service.createToken("share-1", "owner-1");
    shares.get("share-1")!.creatorId = "someone-else";

    await assert.rejects(
      () => service.validateToken("share-1", token),
      UnauthorizedException,
    );
    // A personal share has no Team rule to consult.
    assert.deepEqual(teamChecks, []);
  },
);

void run();
