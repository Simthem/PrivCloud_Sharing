import { accountEmailExists } from "src/user/account-email.util";
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import https from "node:https";
import { AddressInfo } from "node:net";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import cookieParser from "cookie-parser";
import { TeamExternalContractorController } from "src/teamExternal/team-external.controller";
import { TeamExternalService } from "src/teamExternal/team-external.service";
import { TeamExternalAuditService } from "src/teamExternal/team-external-audit.service";
import { AccountPasskeyService } from "src/passkey/accountPasskey.service";
import { ConfigService } from "src/config/config.service";
import { AuthenticatedUserGuard } from "src/auth/guard/authenticatedUser.guard";
import { JwtStrategy } from "src/auth/strategy/jwt.strategy";
import {
  buildIssuanceManifest,
  issuanceChallenge,
} from "src/teamExternal/team-external-audit.util";

async function main() {
  const directory = await mkdtemp(
    join(tmpdir(), "privcloud-contractor-sqlite-"),
  );
  const connectionString = `file:${join(directory, "fixture.db")}`;
  await writeFile(join(directory, "fixture.db"), "");
  try {
    execFileSync(
      process.execPath,
      ["node_modules/prisma/build/index.js", "migrate", "deploy"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: connectionString },
        stdio: "pipe",
      },
    );
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: connectionString }),
  });
  const secret = randomBytes(32).toString("hex");
  const config = {
    get: (key: string) =>
      key === "internal.jwtSecret"
        ? secret
        : key === "share.allowUnauthenticatedShares"
          ? true
          : "https://share.example.test",
  };
  const approval = new AccountPasskeyService(prisma as never, config as never);
  const audit = new TeamExternalAuditService(
    prisma as never,
    config as never,
    { getTimestamp: async () => null } as never,
    approval,
  );
  const files = {
    getFileByKey: (key: string) =>
      readFile(join(directory, key.replaceAll("/", "_"))),
    storeFileByKey: (key: string, bytes: Buffer) =>
      writeFile(join(directory, key.replaceAll("/", "_")), bytes),
  };
  const service = new TeamExternalService(
    prisma as never,
    config as never,
    files as never,
    {} as never,
    audit,
  );
  const strategy = new JwtStrategy(config as never, prisma as never);
  class TestModule {}
  Module({
    controllers: [TeamExternalContractorController],
    providers: [
      { provide: ConfigService, useValue: config },
      { provide: TeamExternalService, useValue: service },
      { provide: JwtStrategy, useValue: strategy },
      AuthenticatedUserGuard,
    ],
  })(TestModule);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  const ca = await readFile(join(directory, "cert.pem"));
  const app = await NestFactory.create(TestModule, {
    logger: false,
    httpsOptions: {
      key: await readFile(join(directory, "key.pem")),
      cert: ca,
    },
  });
  app.use(cookieParser());
  try {
    await app.listen(0, "127.0.0.1");
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const jwt = new JwtService({ secret });
    const expires = new Date(Date.now() + 86_400_000);
    const users = await Promise.all(
      ["admin", "contractor", "other"].map((name) =>
        prisma.user.create({
          data: {
            username: `${name}-${randomUUID()}`,
            email: `${randomUUID()}@example.test`,
            totpVerified: true,
          },
        }),
      ),
    );
    const [admin, contractor] = users;
    await prisma.user.update({
      where: { id: contractor.id },
      data: { email: contractor.email.toUpperCase() },
    });
    assert.equal(
      await accountEmailExists(prisma as never, contractor.email),
      true,
    );
    assert.equal(
      await accountEmailExists(prisma as never, "' OR 1 = 1 --"),
      false,
    );
    await prisma.user.update({
      where: { id: contractor.id },
      data: { email: contractor.email },
    });

    const sessions = await Promise.all(
      users.map((user) =>
        prisma.refreshToken.create({
          data: {
            userId: user.id,
            expiresAt: expires,
          },
        }),
      ),
    );
    const tokens = users.map((user, i) =>
      jwt.sign(
        { sub: user.id, refreshTokenId: sessions[i].id },
        { expiresIn: "1h" },
      ),
    );
    const team = await prisma.team.create({
      data: {
        name: "Synthetic",
        slug: randomUUID(),
        ownerId: admin.id,
        members: {
          create: { userId: admin.id, role: "OWNER", isActive: true },
        },
      },
    });
    const share = await prisma.share.create({
      data: { expiration: expires, creatorId: admin.id },
    });
    const source = await prisma.file.create({
      data: { shareId: share.id, name: "synthetic", size: "64" },
    });
    const seat = await prisma.teamExternalSeat.create({
      data: {
        teamId: team.id,
        userId: contractor.id,
        email: contractor.email,
        status: "ACTIVE",
        inviteExpiresAt: expires,
        accessExpiresAt: expires,
      },
    });
    const preview = await prisma.teamExternalPreview.create({
      data: {
        teamId: team.id,
        seatId: seat.id,
        sourceFileId: source.id,
        createdById: admin.id,
        pageCount: 1,
        encryptedManifest: "opaque",
        encryptedKey: "opaque",
        ephemeralPublicKey: "opaque",
        nonce: "opaque",
        kemCiphertext: "opaque",
        algorithm: "opaque",
      },
    });
    const bytes = Buffer.alloc(64, 7);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const manifest = buildIssuanceManifest({
      nonce: randomBytes(32).toString("base64url"),
      issuedAt: new Date(),
      team: { id: team.id, name: team.name },
      issuer: { userId: admin.id, email: admin.email },
      contractor: { seatId: seat.id, email: contractor.email, name: null },
      accessExpiresAt: expires,
      previewId: preview.id,
      sourceFileId: source.id,
      client: {
        markId: randomBytes(16).toString("hex"),
        sourceSha256: digest,
        pages: [
          {
            plainSha256: digest,
            cipherSha256: digest,
            width: 100,
            height: 100,
          },
        ],
      },
    });
    // This integration begins after signature verification; separate real ES256
    // vectors test the assertion itself. No fabricated signature is advertised.
    await prisma.teamExternalIssuance.create({
      data: {
        teamId: team.id,
        previewId: preview.id,
        seatId: seat.id,
        contractorEmail: contractor.email,
        issuerId: admin.id,
        issuerEmail: admin.email,
        markId: manifest.copy.markId,
        manifest: issuanceChallenge(manifest).canonical,
        manifestHash: issuanceChallenge(manifest).hash,
        credentialId: "test-only",
        credentialPublicKey: "test-only",
        credentialAlgorithm: -7,
        authenticatorData: "test-only",
        clientDataJSON: "test-only",
        signature: "test-only",
        recordHash: digest,
      },
    });
    const request = (token?: string) =>
      new Promise<{ status: number; bytes: Buffer; cache: string | undefined }>(
        (resolve, reject) => {
          const req = https.get(
            {
              hostname: "127.0.0.1",
              port,
              path: `/external/previews/${preview.id}/pages/0`,
              ca,
              headers: token ? { cookie: `access_token=${token}` } : {},
              timeout: 10_000,
            },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk) => chunks.push(chunk));
              response.on("end", () =>
                resolve({
                  status: response.statusCode!,
                  bytes: Buffer.concat(chunks),
                  cache: response.headers["cache-control"],
                }),
              );
            },
          );
          req.on("error", reject);
          req.on("timeout", () => req.destroy(new Error("request timeout")));
        },
      );
    assert.equal((await request()).status, 401);
    assert.equal((await request(tokens[1])).status, 404);
    await service.uploadPage(team.id, preview.id, 0, admin, bytes);
    const append = audit.appendEventInTransaction.bind(audit);
    audit.appendEventInTransaction = async () => {
      throw new Error("synthetic journal failure");
    };
    await assert.rejects(
      service.completePreview(team.id, preview.id, admin),
      /journal failure/,
    );
    assert.equal(
      (
        await prisma.teamExternalPreview.findUniqueOrThrow({
          where: { id: preview.id },
        })
      ).status,
      "UPLOADING",
    );
    assert.equal(
      (
        await prisma.teamExternalIssuance.findUniqueOrThrow({
          where: { previewId: preview.id },
        })
      ).status,
      "APPROVED",
    );
    audit.appendEventInTransaction = append;
    await service.completePreview(team.id, preview.id, admin);
    const positive = await request(tokens[1]);
    assert.equal(positive.status, 200);
    assert.deepEqual(positive.bytes, bytes);
    assert.equal(positive.cache, "private, no-store");
    assert.equal((await request(tokens[2])).status, 404);
    const fetchPage = files.getFileByKey;
    files.getFileByKey = async (key) => {
      const result = await fetchPage(key);
      await prisma.teamExternalSeat.update({
        where: { id: seat.id },
        data: { status: "REVOKED" },
      });
      return result;
    };
    assert.equal((await request(tokens[1])).status, 404);
    files.getFileByKey = fetchPage;
    await prisma.teamExternalSeat.update({
      where: { id: seat.id },
      data: { status: "ACTIVE" },
    });
    await assert.rejects(
      service.uploadPage(team.id, preview.id, 0, admin, Buffer.alloc(64, 8)),
    );
    await files.storeFileByKey(
      `external-previews/${preview.id}/0.bin`,
      Buffer.alloc(64, 8),
    );
    assert.equal((await request(tokens[1])).status, 409);
    await files.storeFileByKey(`external-previews/${preview.id}/0.bin`, bytes);
    await prisma.teamExternalSeat.update({
      where: { id: seat.id },
      data: { accessExpiresAt: new Date(0) },
    });
    assert.equal((await request(tokens[1])).status, 404);
    await prisma.teamExternalSeat.update({
      where: { id: seat.id },
      data: { accessExpiresAt: expires },
    });
    await prisma.refreshToken.delete({ where: { id: sessions[1].id } });
    assert.equal((await request(tokens[1])).status, 401);
    const newSession = await prisma.refreshToken.create({
      data: { userId: contractor.id, expiresAt: expires },
    });
    const fresh = jwt.sign(
      { sub: contractor.id, refreshTokenId: newSession.id },
      { expiresIn: "1h" },
    );
    await prisma.teamExternalSeat.update({
      where: { id: seat.id },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    assert.equal((await request(fresh)).status, 404);
    const chain = await audit.verifyChain(team.id);
    assert.equal(chain.valid, true);
    await Promise.all(
      Array.from({ length: 20 }, () =>
        audit.appendEvent({
          teamId: team.id,
          kind: "OPENED",
          actorEmail: contractor.email,
          previewId: preview.id,
        }),
      ),
    );
    assert.equal((await audit.verifyChain(team.id)).valid, true);
    const head = await prisma.teamExternalAuditEvent.findFirstOrThrow({
      where: { teamId: team.id },
      orderBy: { seq: "desc" },
    });
    await prisma.teamExternalAuditAnchor.create({
      data: {
        teamId: team.id,
        seq: head.seq,
        hash: head.hash,
        timestampToken: "synthetic-boundary",
      },
    });
    await prisma.teamExternalAuditEvent.delete({ where: { id: head.id } });
    assert.equal((await audit.verifyChain(team.id)).valid, false);
    await prisma.signingTimestamp.create({
      data: {
        scope: "forensic",
        documentId: team.id,
        messageImprint: randomBytes(32).toString("hex"),
        tsaUrl: "https://tsa.example.test",
        requestBase64: "test-only",
        responseBase64: "test-only",
      },
    });
    const retained = await prisma.teamExternalIssuance.count({
      where: { teamId: team.id },
    });
    assert.ok(retained > 0);
    await prisma.team.delete({ where: { id: team.id } });
    assert.equal(
      await prisma.teamExternalPreview.count({ where: { teamId: team.id } }),
      0,
    );
    assert.equal(
      await prisma.teamExternalIssuance.count({ where: { teamId: team.id } }),
      retained,
    );
    await audit.eraseTeam(team.id);
    assert.equal(
      await prisma.signingTimestamp.count({
        where: { scope: "forensic", documentId: team.id },
      }),
      0,
    );
    console.log(
      "contractor SQLite + HTTPS integration passed: real JWT/session, publication, isolation, expiry, revocation, storage integrity and concurrent journal",
    );
  } finally {
    await app.close();
    await prisma.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
