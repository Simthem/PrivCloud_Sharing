import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, TeamExternalIssuance, User } from "@prisma/client";
import { randomBytes } from "crypto";
import { readFile } from "fs/promises";
import { join } from "path";
import { ConfigService } from "src/config/config.service";
import { PrismaService } from "src/prisma/prisma.service";
import { PdfSigningService } from "src/signing/pdf-signing.service";
import { pdfSafeText } from "src/signing/pdf-text.util";
import { createZipArchive } from "src/utils/archive.util";
import { AccountPasskeyService } from "src/passkey/accountPasskey.service";
import { PasskeyResponseDTO } from "src/passkey/dto/passkey.dto";
import {
  ApproveIssuanceDTO,
  PrepareIssuanceDTO,
  SetTeamAuditKeyDTO,
} from "./dto/team-external.dto";
import {
  AUDIT_CHAIN_START,
  AUDIT_EVENT_PROTOCOL,
  AuditEventKind,
  auditEventContentHash,
  auditEventHash,
  auditEventHashFormat,
  legacyAuditEventHash,
  buildIssuanceManifest,
  EXTERNAL_AUDIT_RETENTION_MS,
  IssuanceManifest,
  issuanceChallenge,
  issuanceRecordHash,
  isValidEncryptedAuditKey,
  isValidEncryptedLabel,
  isValidIssuanceInput,
  verifyAuditChain,
} from "./team-external-audit.util";
import { EXTERNAL_UPLOAD_TTL_MS, isSeatUsable } from "./team-external.util";

const ADMIN_ROLES = ["OWNER", "ADMIN"];

const VERIFICATION_INTRO =
  "Le dossier de preuve (ZIP) se télécharge depuis le registre de l'équipe. Il contient ce certificat, preuve.json (toutes les données à vérifier), les jetons d'horodatage (.tsr) et verifier.py, un script qui refait chaque contrôle sans PrivCloud. preuve.json est aussi joint à ce PDF.";

const VERIFICATION_STEPS = [
  "Extraire le ZIP, puis lancer dans ce dossier : python3 verifier.py (Python 3 et OpenSSL suffisent, ils sont présents sur Linux et macOS). Avec --original suivi du fichier d'origine, le script vérifie aussi que c'est bien ce fichier qui a été remis.",
  "Ce qui a été validé : le script recalcule l'empreinte du manifeste (équipe, administrateur, prestataire, fichier, durée d'accès) et la compare à celle que la passkey a signée.",
  "Qui l'a validé : la signature de la passkey de l'administrateur est vérifiée avec sa clé publique, ainsi que la vérification de l'utilisateur (code, empreinte ou visage).",
  "Quand : une autorité d'horodatage indépendante a signé l'empreinte de l'enregistrement. Le script contrôle ce jeton et affiche sa date.",
  "Ce que le prestataire a consulté : chaque événement du journal contient l'empreinte du précédent. En modifier, supprimer ou insérer un casse la chaîne, et les ancrages horodatés datent chaque événement au plus tard.",
  "Chaque contrôle s'affiche OK, ATTENTION ou ÉCHEC, avec sa raison. Un seul ÉCHEC suffit pour écarter le dossier.",
];
const CHAIN_BATCH = 5000;

type Transaction = Prisma.TransactionClient;

/**
 * Evidence about the copies issued to external contractors: who approved
 * which copy for whom (register signed with a passkey, timestamped by a
 * TSA), and what the contractor opened (hash-chained journal). The invisible
 * mark of each copy is derived in the browser from the team audit key, which
 * the server only stores wrapped with K_team.
 */
@Injectable()
export class TeamExternalAuditService {
  private readonly logger = new Logger(TeamExternalAuditService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private pdfSigning: PdfSigningService,
    private approval: AccountPasskeyService,
  ) {}

  private async assertTeamAdmin(teamId: string, user: User) {
    const member = await this.prisma.teamMember.findFirst({
      where: {
        teamId,
        userId: user.id,
        isActive: true,
        role: { in: ADMIN_ROLES },
        team: { isActive: true },
      },
      select: { id: true },
    });
    if (!member) {
      throw new ForbiddenException(
        "Only an administrator of an active team can read its audit",
      );
    }
  }

  // ===========================================================================
  // TEAM AUDIT KEY
  // ===========================================================================

  async getAuditKey(teamId: string, user: User) {
    await this.assertTeamAdmin(teamId, user);
    return (
      (await this.prisma.teamAuditKey.findUnique({
        where: { teamId },
        select: { encryptedKey: true, keyVersion: true },
      })) ?? null
    );
  }

  /**
   * Created once. Replacing it would make every mark issued so far
   * undetectable, so only a key rotation re-wraps it.
   */
  async createAuditKey(teamId: string, user: User, dto: SetTeamAuditKeyDTO) {
    await this.assertTeamAdmin(teamId, user);
    if (!isValidEncryptedAuditKey(dto.encryptedKey)) {
      throw new BadRequestException("Invalid encrypted audit key");
    }
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { keyVersion: true },
    });
    if (!team) throw new NotFoundException("Team not found");
    if (dto.keyVersion !== team.keyVersion) {
      throw new ConflictException(
        "The team key changed, reload the page and try again",
      );
    }
    try {
      return await this.prisma.teamAuditKey.create({
        data: {
          teamId,
          encryptedKey: dto.encryptedKey,
          keyVersion: dto.keyVersion,
          createdById: user.id,
        },
        select: { encryptedKey: true, keyVersion: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException(
          "The team audit key already exists",
          "audit_key_exists",
        );
      }
      throw error;
    }
  }

  // ===========================================================================
  // JOURNAL
  // ===========================================================================

  /**
   * Appends an event to the chain of the team. Teams are serialized with an
   * SQLite writer lock so that two events never share a sequence number.
   */
  async appendEvent(event: {
    teamId: string;
    kind: AuditEventKind;
    actorEmail: string;
    previewId?: string | null;
    seatId?: string | null;
    pageIndex?: number | null;
  }) {
    await this.prisma.$transaction((tx) =>
      this.appendEventInTransaction(tx, event),
    );
  }

  /** Also used by publication so visibility and its journal commit together. */
  async appendEventInTransaction(
    tx: Transaction,
    event: Parameters<TeamExternalAuditService["appendEvent"]>[0],
  ) {
    await tx.$executeRaw`UPDATE "TeamExternalAuditEvent" SET "id" = "id" WHERE "teamId" = ${event.teamId}`;
    const last = await tx.teamExternalAuditEvent.findFirst({
      where: { teamId: event.teamId },
      orderBy: { seq: "desc" },
      select: { seq: true, hash: true },
    });
    const content = {
      teamId: event.teamId,
      seq: (last?.seq ?? 0) + 1,
      at: new Date(),
      kind: event.kind,
      previewId: event.previewId ?? null,
      seatId: event.seatId ?? null,
      actorEmail: event.actorEmail,
      pageIndex: event.pageIndex ?? null,
      prevHash: last?.hash ?? AUDIT_CHAIN_START,
    };
    await tx.teamExternalAuditEvent.create({
      data: { ...content, hash: auditEventHash(content) },
    });
  }

  /** Recomputes the whole chain of a team, in batches. */
  async verifyChain(teamId: string) {
    const anchors = await this.prisma.teamExternalAuditAnchor.findMany({
      where: { teamId },
      orderBy: { seq: "asc" },
      select: { seq: true, hash: true, createdAt: true },
    });
    let previous: Parameters<typeof verifyAuditChain>[0][number] | null = null;
    let count = 0;
    for (let cursor = 0; ; ) {
      const batch = await this.prisma.teamExternalAuditEvent.findMany({
        where: { teamId, seq: { gt: cursor } },
        orderBy: { seq: "asc" },
        take: CHAIN_BATCH,
      });
      if (batch.length === 0) break;
      const events = previous ? [previous, ...batch] : batch;
      const inBatch = anchors.filter(
        (anchor) =>
          anchor.seq >= events[0].seq &&
          anchor.seq <= events[events.length - 1].seq,
      );
      const result = verifyAuditChain(events, inBatch);
      if (!result.valid) {
        return {
          valid: false,
          events: count + batch.length,
          brokenAtSeq: result.brokenAtSeq,
          reason: result.reason,
          lastAnchorAt: anchors.at(-1)?.createdAt ?? null,
        };
      }
      count += batch.length;
      previous = batch[batch.length - 1];
      cursor = previous.seq;
    }
    // Anchors beyond the retained head expose a truncated or deleted journal.
    const missingAnchor = anchors.find(
      (anchor) => anchor.seq > (previous?.seq ?? 0),
    );
    return {
      valid: !missingAnchor,
      events: count,
      brokenAtSeq: missingAnchor?.seq ?? null,
      reason: missingAnchor ? "anchor_ahead_of_head" : null,
      lastAnchorAt: anchors.at(-1)?.createdAt ?? null,
      lastSeq: previous?.seq ?? 0,
      lastAnchoredSeq: anchors.at(-1)?.seq ?? 0,
      unanchoredEvents: Math.max(
        0,
        (previous?.seq ?? 0) - (anchors.at(-1)?.seq ?? 0),
      ),
    };
  }

  async listJournal(teamId: string, user: User, previewId?: string) {
    await this.assertTeamAdmin(teamId, user);
    return this.journalOf(teamId, previewId);
  }

  /** Private, read-only evidence about the first failing event. Never repairs hashes. */
  async journalDiagnostic(teamId: string, user: User) {
    await this.assertTeamAdmin(teamId, user);
    const verification = await this.verifyChain(teamId);
    const event =
      verification.brokenAtSeq === null
        ? null
        : await this.prisma.teamExternalAuditEvent.findUnique({
            where: { teamId_seq: { teamId, seq: verification.brokenAtSeq } },
          });
    return {
      format: "privcloud-private-journal-diagnostic-v1",
      generatedAt: new Date().toISOString(),
      teamId,
      verification,
      event: event
        ? {
            seq: event.seq,
            at: event.at.toISOString(),
            kind: event.kind,
            previewId: event.previewId,
            seatId: event.seatId,
            actorEmail: event.actorEmail,
            pageIndex: event.pageIndex,
            prevHash: event.prevHash,
            storedHash: event.hash,
            calculatedHash: auditEventHash(event),
            legacyCalculatedHash: legacyAuditEventHash(event),
            hashFormat: auditEventHashFormat(event),
            contentHash: auditEventContentHash(event),
          }
        : null,
      limits:
        "Private diagnostic of the whole team chain. No data is rewritten. This is not a timestamped checkpoint or an independent integrity proof.",
    };
  }

  /** The last events of a chain and its verification, without any check. */
  async journalOf(teamId: string, previewId?: string) {
    const events = await this.prisma.teamExternalAuditEvent.findMany({
      where: { teamId, ...(previewId ? { previewId } : {}) },
      orderBy: { seq: "desc" },
      take: 500,
      select: {
        seq: true,
        at: true,
        kind: true,
        previewId: true,
        actorEmail: true,
        pageIndex: true,
        hash: true,
      },
    });
    return { events, verification: await this.verifyChain(teamId) };
  }

  /** Hourly: a TSA timestamps the head of every chain that moved. */
  async anchorChains() {
    const heads = await this.prisma.teamExternalAuditEvent.groupBy({
      by: ["teamId"],
      _max: { seq: true },
    });
    for (const head of heads) {
      const seq = head._max.seq;
      if (!seq) continue;
      const anchored = await this.prisma.teamExternalAuditAnchor.findFirst({
        where: { teamId: head.teamId, seq: { gte: seq } },
        select: { id: true },
      });
      if (anchored) continue;
      const event = await this.prisma.teamExternalAuditEvent.findUnique({
        where: { teamId_seq: { teamId: head.teamId, seq } },
        select: { hash: true },
      });
      if (!event) continue;
      const token = await this.timestamp(event.hash, head.teamId);
      if (!token) continue;
      await this.prisma.teamExternalAuditAnchor.create({
        data: {
          teamId: head.teamId,
          seq,
          hash: event.hash,
          timestampToken: token,
        },
      });
    }
  }

  // ===========================================================================
  // REGISTER
  // ===========================================================================

  private async uploadingPreview(
    teamId: string,
    previewId: string,
    user: User,
  ) {
    await this.assertTeamAdmin(teamId, user);
    const preview = await this.prisma.teamExternalPreview.findFirst({
      where: {
        id: previewId,
        teamId,
        createdById: user.id,
        status: "UPLOADING",
        deletedAt: null,
      },
      include: {
        seat: { include: { user: { select: { username: true } } } },
        team: { select: { id: true, name: true } },
      },
    });
    if (!preview || !preview.sourceFileId) {
      throw new NotFoundException("Preview not found");
    }
    if (!isSeatUsable(preview.seat, new Date())) {
      throw new NotFoundException("Seat not found");
    }
    return preview;
  }

  /**
   * Builds the register entry of a copy and the WebAuthn options asking the
   * administrator to approve exactly it.
   */
  async prepareIssuance(
    teamId: string,
    previewId: string,
    user: User,
    dto: PrepareIssuanceDTO,
  ) {
    const preview = await this.uploadingPreview(teamId, previewId, user);
    if (!isValidIssuanceInput(dto, preview.pageCount)) {
      throw new BadRequestException("Invalid copy description");
    }
    const [existing, sameMark] = await Promise.all([
      this.prisma.teamExternalIssuance.count({ where: { previewId } }),
      this.prisma.teamExternalIssuance.count({
        where: { teamId, markId: dto.markId },
      }),
    ]);
    if (existing > 0) throw new ConflictException("Copy already approved");
    if (sameMark > 0) throw new ConflictException("Mark already used");
    const manifest = buildIssuanceManifest({
      nonce: randomBytes(32).toString("base64url"),
      issuedAt: new Date(),
      team: { id: preview.team.id, name: preview.team.name },
      issuer: { userId: user.id, email: user.email },
      contractor: {
        seatId: preview.seat.id,
        email: preview.seat.email,
        name: preview.seat.displayName || preview.seat.user?.username || null,
      },
      accessExpiresAt: preview.seat.accessExpiresAt,
      previewId,
      sourceFileId: preview.sourceFileId!,
      client: dto,
    });
    const { canonical, hash } = issuanceChallenge(manifest);
    const ceremony = await this.approval.beginIssue(
      user,
      previewId,
      canonical,
      hash,
    );
    return { ...ceremony, manifest, manifestHash: hash };
  }

  /** Checks the passkey signature and writes the register entry. */
  async approveIssuance(
    teamId: string,
    previewId: string,
    user: User,
    dto: ApproveIssuanceDTO,
  ) {
    const preview = await this.uploadingPreview(teamId, previewId, user);
    if (
      dto.encryptedLabel !== undefined &&
      !isValidEncryptedLabel(dto.encryptedLabel)
    ) {
      throw new BadRequestException("Invalid encrypted label");
    }
    const assertion = await this.approval.verifyIssue(user, previewId, dto);
    const manifest = JSON.parse(assertion.manifest) as IssuanceManifest;
    if (
      manifest.copy.previewId !== preview.id ||
      manifest.team.id !== teamId ||
      manifest.contractor.seatId !== preview.seatId ||
      manifest.copy.pageCount !== preview.pageCount ||
      manifest.copy.sourceFileId !== preview.sourceFileId ||
      manifest.issuer.userId !== user.id ||
      manifest.accessExpiresAt !== preview.seat.accessExpiresAt.toISOString()
    ) {
      throw new ConflictException("The copy changed after it was described");
    }
    const record = {
      manifest: assertion.manifest,
      credentialId: assertion.credentialId,
      credentialPublicKey: assertion.credentialPublicKey,
      credentialAlgorithm: assertion.credentialAlgorithm,
      authenticatorData: assertion.authenticatorData,
      clientDataJSON: assertion.clientDataJSON,
      signature: assertion.signature,
    };
    try {
      const issuance = await this.prisma.teamExternalIssuance.create({
        data: {
          ...record,
          teamId,
          previewId,
          seatId: preview.seatId,
          contractorEmail: manifest.contractor.email,
          contractorName: manifest.contractor.name,
          issuerId: user.id,
          issuerEmail: user.email,
          markId: manifest.copy.markId,
          manifestHash: assertion.manifestHash,
          encryptedLabel: dto.encryptedLabel ?? null,
          userHandle: assertion.userHandle,
          recordHash: issuanceRecordHash(record),
        },
        select: { id: true },
      });
      return { issuanceId: issuance.id };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new ConflictException("Copy already approved");
      }
      throw error;
    }
  }

  /**
   * Inside the transaction that makes a copy visible: it must have been
   * approved, and every stored page must be the one the passkey signed.
   */
  async finalizeIssuance(tx: Transaction, previewId: string) {
    const issuance = await tx.teamExternalIssuance.findUnique({
      where: { previewId },
      select: { id: true, status: true, manifest: true },
    });
    if (!issuance || issuance.status !== "APPROVED") {
      throw new ForbiddenException(
        "The copy must be approved with a passkey",
        "approval_required",
      );
    }
    const manifest = JSON.parse(issuance.manifest) as IssuanceManifest;
    const current = await tx.teamExternalPreview.findFirst({
      where: {
        id: previewId,
        teamId: manifest.team.id,
        seatId: manifest.contractor.seatId,
        sourceFileId: manifest.copy.sourceFileId,
        createdById: manifest.issuer.userId,
        status: "UPLOADING",
        deletedAt: null,
        team: {
          isActive: true,
          members: {
            some: {
              userId: manifest.issuer.userId,
              isActive: true,
              role: { in: ADMIN_ROLES },
            },
          },
        },
        seat: {
          status: "ACTIVE",
          userId: { not: null },
          accessExpiresAt: new Date(manifest.accessExpiresAt),
        },
      },
      select: { id: true },
    });
    if (!current || new Date(manifest.accessExpiresAt) <= new Date()) {
      throw new ConflictException(
        "Access or administrator changed after approval",
      );
    }
    const pages = await tx.teamExternalPreviewPage.findMany({
      where: { previewId },
      select: { index: true, sha256: true },
    });
    const stored = new Map(pages.map((page) => [page.index, page.sha256]));
    const matches = manifest.copy.pages.every(
      (page, index) => stored.get(index) === page.cipherSha256,
    );
    if (!matches || pages.length !== manifest.copy.pages.length) {
      throw new ConflictException(
        "The stored pages differ from the approved copy",
      );
    }
    await tx.teamExternalIssuance.update({
      where: { id: issuance.id },
      data: { status: "ISSUED", issuedAt: new Date() },
    });
    return issuance.id;
  }

  private async timestamp(
    hashHex: string,
    documentId: string,
  ): Promise<string | null> {
    try {
      const response = await this.pdfSigning.getTimestamp(
        Buffer.from(hashHex, "hex"),
        { scope: "forensic", documentId },
      );
      return response ? response.toString("base64") : null;
    } catch {
      this.logger.warn("Could not timestamp contractor audit evidence");
      return null;
    }
  }

  /** Best effort right after issuing, then retried by the hourly job. */
  async timestampIssuance(issuanceId: string) {
    const issuance = await this.prisma.teamExternalIssuance.findUnique({
      where: { id: issuanceId },
      select: { recordHash: true, timestampToken: true, status: true },
    });
    if (!issuance || issuance.status !== "ISSUED" || issuance.timestampToken)
      return;
    const token = await this.timestamp(issuance.recordHash, issuanceId);
    if (!token) return;
    await this.prisma.teamExternalIssuance.updateMany({
      where: { id: issuanceId, timestampToken: null },
      data: { timestampToken: token, timestampedAt: new Date() },
    });
  }

  async timestampPendingIssuances() {
    const pending = await this.prisma.teamExternalIssuance.findMany({
      where: { status: "ISSUED", timestampToken: null },
      select: { id: true },
      take: 100,
    });
    for (const issuance of pending) await this.timestampIssuance(issuance.id);
  }

  async listIssuances(teamId: string, user: User) {
    await this.assertTeamAdmin(teamId, user);
    return this.issuancesOf(teamId);
  }

  /** Register entries of a team, without any check. */
  async issuancesOf(teamId: string) {
    const [issuances, live] = await Promise.all([
      this.prisma.teamExternalIssuance.findMany({
        where: { teamId, status: "ISSUED" },
        orderBy: { issuedAt: "desc" },
        take: 500,
        select: {
          id: true,
          issuedAt: true,
          previewId: true,
          seatId: true,
          contractorEmail: true,
          contractorName: true,
          issuerEmail: true,
          markId: true,
          manifestHash: true,
          encryptedLabel: true,
          timestampedAt: true,
          manifest: true,
        },
      }),
      this.prisma.teamExternalPreview.findMany({
        where: { teamId, deletedAt: null, status: "READY" },
        select: { id: true },
      }),
    ]);
    const available = new Set(live.map((preview) => preview.id));
    return issuances.map(({ manifest, ...issuance }) => {
      const parsed = JSON.parse(manifest) as IssuanceManifest;
      return {
        ...issuance,
        pageCount: parsed.copy.pageCount,
        sourceSha256: parsed.copy.sourceSha256,
        ...(parsed.copy.robustMarkAlgorithm
          ? { robustMarkAlgorithm: parsed.copy.robustMarkAlgorithm }
          : {}),
        sourceFileId: parsed.copy.sourceFileId,
        accessExpiresAt: parsed.accessExpiresAt,
        copyAvailable: available.has(issuance.previewId),
      };
    });
  }

  // ===========================================================================
  // CERTIFICATE
  // ===========================================================================

  /**
   * PDF certificate of one register entry, sealed by the platform (PAdES)
   * when a signing certificate is configured. The full evidence travels as an
   * attached JSON file that anyone can check without PrivCloud.
   */
  /** Everything an auditor needs about one register entry. */
  private async collectEvidence(teamId: string, issuanceId: string) {
    const issuance = await this.prisma.teamExternalIssuance.findFirst({
      where: { id: issuanceId, teamId, status: "ISSUED" },
    });
    if (!issuance) throw new NotFoundException("Register entry not found");
    const manifest = JSON.parse(issuance.manifest) as IssuanceManifest;
    const [events, verification] = await Promise.all([
      this.prisma.teamExternalAuditEvent.findMany({
        where: { teamId, previewId: issuance.previewId },
        orderBy: { seq: "asc" },
      }),
      this.verifyChain(teamId),
    ]);
    // Each event of the copy is dated by the first anchor at or after it. The
    // chain is given up to the last of those anchors, the events of other
    // copies showing only as bare links.
    const anchorSeqs = events.length
      ? await this.prisma.teamExternalAuditAnchor.findMany({
          where: { teamId, seq: { gte: events[0].seq } },
          orderBy: { seq: "asc" },
          select: { seq: true },
        })
      : [];
    const covering = new Set<number>();
    let next = 0;
    for (const event of events) {
      while (next < anchorSeqs.length && anchorSeqs[next].seq < event.seq) {
        next++;
      }
      if (next < anchorSeqs.length) covering.add(anchorSeqs[next].seq);
    }
    const anchors = covering.size
      ? await this.prisma.teamExternalAuditAnchor.findMany({
          where: { teamId, seq: { in: [...covering] } },
          orderBy: { seq: "asc" },
        })
      : [];
    const links = events.length
      ? await this.chainLinks(
          teamId,
          events[0].seq,
          Math.max(events[events.length - 1].seq, anchors.at(-1)?.seq ?? 0),
        )
      : [];
    const exchanges = await this.prisma.signingTimestamp.findMany({
      where: {
        scope: "forensic",
        messageImprint: {
          in: [issuance.recordHash, ...anchors.map((a) => a.hash)],
        },
      },
      select: {
        messageImprint: true,
        requestBase64: true,
        responseBase64: true,
      },
    });
    const requestFor = (hash: string, token: string | null) =>
      exchanges.find(
        (exchange) =>
          exchange.messageImprint === hash && exchange.responseBase64 === token,
      )?.requestBase64 ?? null;
    const generatedAt = new Date();
    const evidence = {
      format: "privcloud-contractor-issuance-evidence-v1",
      generatedAt: generatedAt.toISOString(),
      issuance: {
        id: issuance.id,
        manifest: issuance.manifest,
        manifestHash: issuance.manifestHash,
        webauthn: {
          credentialId: issuance.credentialId,
          publicKeyCoseBase64Url: issuance.credentialPublicKey,
          algorithm: issuance.credentialAlgorithm,
          authenticatorDataBase64Url: issuance.authenticatorData,
          clientDataJSONBase64Url: issuance.clientDataJSON,
          signatureBase64Url: issuance.signature,
          userHandleBase64Url: issuance.userHandle,
        },
        recordHash: issuance.recordHash,
        rfc3161TimeStampRespBase64: issuance.timestampToken,
        rfc3161TimeStampReqBase64: requestFor(
          issuance.recordHash,
          issuance.timestampToken,
        ),
      },
      howToVerify: VERIFICATION_STEPS,
      journal: {
        protocol: AUDIT_EVENT_PROTOCOL,
        teamId,
        chainValidAtGeneration: verification.valid,
        events: events.map((event) => ({
          seq: event.seq,
          at: event.at.toISOString(),
          kind: event.kind,
          previewId: event.previewId,
          seatId: event.seatId,
          actorEmail: event.actorEmail,
          pageIndex: event.pageIndex,
          prevHash: event.prevHash,
          hash: event.hash,
        })),
        links,
        anchors: anchors.map((anchor) => ({
          seq: anchor.seq,
          hash: anchor.hash,
          rfc3161TimeStampRespBase64: anchor.timestampToken,
          rfc3161TimeStampReqBase64: requestFor(
            anchor.hash,
            anchor.timestampToken,
          ),
        })),
      },
    };
    return {
      issuance,
      manifest,
      events,
      verification,
      anchors,
      generatedAt,
      json: Buffer.from(JSON.stringify(evidence, null, 2)),
    };
  }

  /** The links between two events of a chain, without what they say. */
  private async chainLinks(teamId: string, from: number, to: number) {
    const links: {
      seq: number;
      prevHash: string;
      contentHash: string;
      hash: string;
      hashFormat?: "legacy-flat-v1";
    }[] = [];
    for (let cursor = from - 1; cursor < to; ) {
      const batch = await this.prisma.teamExternalAuditEvent.findMany({
        where: { teamId, seq: { gt: cursor, lte: to } },
        orderBy: { seq: "asc" },
        take: CHAIN_BATCH,
      });
      if (batch.length === 0) break;
      for (const event of batch) {
        links.push({
          seq: event.seq,
          prevHash: event.prevHash,
          contentHash: auditEventContentHash(event),
          hash: event.hash,
          ...(auditEventHashFormat(event) === "legacy-flat-v1"
            ? { hashFormat: "legacy-flat-v1" as const }
            : {}),
        });
      }
      cursor = batch[batch.length - 1].seq;
    }
    return links;
  }

  /**
   * Evidence bundle for an auditor, readable without any PDF viewer: the
   * sealed certificate, preuve.json, every RFC 3161 token as a .tsr file, the
   * verification steps and a script that runs them with Python and OpenSSL.
   * Most viewers do not show PDF attachments.
   */
  async prepareDownload(
    teamId: string,
    issuanceId: string,
    user: User,
    kind: "certificate" | "evidence" | "pattern",
  ) {
    await this.assertTeamAdmin(teamId, user);
    const issuance = await this.prisma.teamExternalIssuance.findFirst({
      where: { id: issuanceId, teamId, status: "ISSUED" },
      select: { id: true },
    });
    if (!issuance) throw new NotFoundException("Issuance not found");
    return this.approval.beginTeamEvidence(user, teamId, issuanceId, kind);
  }

  private async authorizeDownload(
    teamId: string,
    issuanceId: string,
    user: User,
    kind: "certificate" | "evidence" | "pattern",
    dto: PasskeyResponseDTO,
  ) {
    await this.assertTeamAdmin(teamId, user);
    await this.approval.verifyTeamEvidence(user, teamId, issuanceId, kind, dto);
    await this.assertTeamAdmin(teamId, user);
  }

  async authorizePatternExport(
    teamId: string,
    issuanceId: string,
    user: User,
    dto: PasskeyResponseDTO,
  ) {
    await this.authorizeDownload(teamId, issuanceId, user, "pattern", dto);
    const issuance = await this.prisma.teamExternalIssuance.findFirst({
      where: { id: issuanceId, teamId, status: "ISSUED" },
      select: { markId: true, manifest: true },
    });
    if (!issuance) throw new NotFoundException("Issuance not found");
    await this.prisma.teamAccessLog.create({
      data: {
        teamId,
        action: "EXTERNAL_PATTERN_EXPORT_AUTHORIZED",
        actorEmail: user.email,
        actorName: user.username,
        targetType: "EXTERNAL_ISSUANCE",
        targetId: issuanceId,
      },
    });
    await this.assertTeamAdmin(teamId, user);
    const manifest = JSON.parse(issuance.manifest) as IssuanceManifest;
    return {
      markId: issuance.markId,
      robustMarkAlgorithm: manifest.copy.robustMarkAlgorithm,
    };
  }

  async evidenceBundle(
    teamId: string,
    issuanceId: string,
    user: User,
    dto: PasskeyResponseDTO,
  ) {
    await this.authorizeDownload(teamId, issuanceId, user, "evidence", dto);
    const bundle = await this.bundleOf(teamId, issuanceId);
    await this.assertTeamAdmin(teamId, user);
    return bundle;
  }

  async bundleOf(teamId: string, issuanceId: string) {
    const evidence = await this.collectEvidence(teamId, issuanceId);
    const certificate = await this.sealedCertificate(evidence);
    const archive = createZipArchive({ zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve, reject) => {
      archive.on("end", () => resolve());
      archive.on("error", reject);
    });
    archive.append(certificate, { name: "certificat.pdf" });
    archive.append(evidence.json, { name: "preuve.json" });
    const checkpointAnchor = evidence.anchors.at(-1);
    if (evidence.issuance.timestampToken && checkpointAnchor) {
      archive.append(
        JSON.stringify(
          {
            format: "privcloud-contractor-checkpoint-v1",
            issuance: {
              recordHash: evidence.issuance.recordHash,
              rfc3161TimeStampRespBase64: evidence.issuance.timestampToken,
              rfc3161TimeStampReqBase64: JSON.parse(evidence.json.toString())
                .issuance.rfc3161TimeStampReqBase64,
            },
            journal: {
              teamId,
              seq: checkpointAnchor.seq,
              hash: checkpointAnchor.hash,
              rfc3161TimeStampRespBase64: checkpointAnchor.timestampToken,
              rfc3161TimeStampReqBase64: JSON.parse(
                evidence.json.toString(),
              ).journal.anchors.at(-1).rfc3161TimeStampReqBase64,
            },
          },
          null,
          2,
        ),
        { name: "checkpoint.json" },
      );
    }

    archive.append(await readFile(join(__dirname, "evidence-verifier.py")), {
      name: "verifier.py",
      mode: 0o755,
    });
    if (evidence.issuance.timestampToken) {
      archive.append(Buffer.from(evidence.issuance.timestampToken, "base64"), {
        name: "horodatage-enregistrement.tsr",
      });
    }
    for (const anchor of evidence.anchors) {
      archive.append(Buffer.from(anchor.timestampToken, "base64"), {
        name: `horodatage-journal-${anchor.seq}.tsr`,
      });
    }
    archive.append(
      Buffer.from(
        [
          "Dossier de preuve PrivCloud",
          "",
          VERIFICATION_INTRO,
          "",
          ...VERIFICATION_STEPS.map((step, index) => `${index + 1}. ${step}`),
          "",
          "Contenu du dossier",
          "- certificat.pdf : le certificat lisible, scellé par la plateforme quand elle dispose d'un certificat de signature.",
          "- preuve.json : les données vérifiables (manifeste, signature de la passkey, jetons d'horodatage, journal).",
          "- verifier.py : le script de vérification. Chaque contrôle y est expliqué en commentaire, pour qui veut le relire avant de le lancer.",
          "- checkpoint.json : présent après horodatage de l'enregistrement et du journal. Conserver ce fichier hors du serveur avant toute compromission.",
          "- fichiers .tsr : les jetons d'horodatage tels que reçus de l'autorité, lisibles avec : openssl ts -reply -in FICHIER.tsr -text",
          "",
          "Vérification stricte : python3 verifier.py --strict --ca RACINE.pem --expected-origin ORIGINE --rp-id RP_ID --original ORIGINAL --checkpoint CHECKPOINT_CONSERVE.json",
          "Choisir la racine de confiance indépendamment du dossier reçu. Un checkpoint reçu après compromission ne prouve pas l'état antérieur.",
          "La chaîne prouve la continuité des maillons fournis. Les événements non horodatés et l'exhaustivité des événements détaillés d'une copie restent des limites.",
          "",
          "Le script ne contacte aucun serveur et ne modifie aucun fichier.",
          "",
        ].join("\n"),
      ),
      { name: "LISEZMOI.txt" },
    );
    await archive.finalize();
    await done;
    return Buffer.concat(chunks);
  }

  async certificate(
    teamId: string,
    issuanceId: string,
    user: User,
    dto: PasskeyResponseDTO,
  ) {
    await this.authorizeDownload(teamId, issuanceId, user, "certificate", dto);
    const pdf = await this.certificateOf(teamId, issuanceId);
    await this.assertTeamAdmin(teamId, user);
    return pdf;
  }

  async certificateOf(teamId: string, issuanceId: string) {
    return this.sealedCertificate(
      await this.collectEvidence(teamId, issuanceId),
    );
  }

  private async sealedCertificate(
    evidence: Awaited<ReturnType<TeamExternalAuditService["collectEvidence"]>>,
  ) {
    const {
      issuance,
      manifest,
      events,
      verification,
      anchors,
      generatedAt,
      json,
    } = evidence;
    const pdf = await this.renderCertificate(
      issuance,
      manifest,
      events,
      verification.valid,
      anchors.length,
      generatedAt,
      json,
    );
    try {
      return await this.pdfSigning.signPdf(pdf, {
        name: (this.config.get("general.appName") as string) || "PrivCloud",
        email: issuance.issuerEmail,
        reason: "Certificat de mise à disposition d'une copie en consultation",
      });
    } catch {
      // No platform certificate: the evidence inside stays verifiable.
      return pdf;
    }
  }

  private async renderCertificate(
    issuance: TeamExternalIssuance,
    manifest: IssuanceManifest,
    events: { at: Date; kind: string; pageIndex: number | null }[],
    chainValid: boolean,
    anchorCount: number,
    generatedAt: Date,
    evidence: Buffer,
  ) {
    const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const mono = await pdfDoc.embedFont(StandardFonts.Courier);
    pdfDoc.setTitle("Certificat de mise à disposition");
    pdfDoc.setCreator("PrivCloud Sharing");
    pdfDoc.setProducer("PrivCloud Sharing");
    let page = pdfDoc.addPage([595.28, 841.89]);
    const height = page.getSize().height;
    let y = height - 56;
    const ensure = (needed: number) => {
      if (y - needed >= 50) return;
      page = pdfDoc.addPage([595.28, 841.89]);
      y = height - 56;
    };
    const wrap = (text: string, size: number, maxWidth: number, f = font) => {
      const words = pdfSafeText(text, f).split(" ");
      const lines: string[] = [];
      let current = "";
      for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (f.widthOfTextAtSize(candidate, size) <= maxWidth || !current) {
          current = candidate;
        } else {
          lines.push(current);
          current = word;
        }
      }
      if (current) lines.push(current);
      return lines;
    };
    const text = (
      value: string,
      options: { size?: number; f?: typeof font; color?: number } = {},
    ) => {
      const size = options.size ?? 9.5;
      const f = options.f ?? font;
      for (const line of wrap(value, size, 495, f)) {
        ensure(size + 4);
        page.drawText(line, {
          x: 50,
          y,
          size,
          font: f,
          color: rgb(
            options.color ?? 0.15,
            options.color ?? 0.15,
            options.color ?? 0.15,
          ),
        });
        y -= size + 4;
      }
    };
    const field = (label: string, value: string, monospace = false) => {
      ensure(30);
      page.drawText(pdfSafeText(label, bold), {
        x: 50,
        y,
        size: 8,
        font: bold,
        color: rgb(0.4, 0.4, 0.45),
      });
      y -= 12;
      text(value, { f: monospace ? mono : font, size: monospace ? 8.5 : 9.5 });
      y -= 4;
    };
    const heading = (value: string) => {
      ensure(40);
      y -= 8;
      page.drawText(pdfSafeText(value, bold), {
        x: 50,
        y,
        size: 11.5,
        font: bold,
        color: rgb(0.1, 0.1, 0.4),
      });
      y -= 18;
    };
    const date = (value: Date | string | null) =>
      value
        ? new Date(value)
            .toLocaleString("fr-FR", {
              timeZone: "Europe/Paris",
              dateStyle: "long",
              timeStyle: "medium",
            })
            // fr-FR separates with narrow no-break spaces, absent from
            // the standard PDF fonts.
            .replace(/[\u00a0\u202f]/g, " ") + " (Europe/Paris)"
        : "-";

    page.drawText(pdfSafeText("CERTIFICAT DE MISE À DISPOSITION", bold), {
      x: 50,
      y,
      size: 16,
      font: bold,
      color: rgb(0.1, 0.1, 0.4),
    });
    y -= 22;
    text(
      "Copie en consultation seule remise à un prestataire externe. Le prestataire n'a pas reçu le fichier original, seulement des images de pages filigranées, chiffrées de bout en bout pour lui et marquées de façon invisible.",
      { color: 0.35 },
    );

    heading("Mise à disposition");
    field("Référence du registre", issuance.id);
    field("Équipe", `${manifest.team.name} (${manifest.team.id})`);
    field("Validée par", manifest.issuer.email);
    field("Date de validation", date(manifest.issuedAt));
    field(
      "Prestataire",
      manifest.contractor.name
        ? `${manifest.contractor.name} - ${manifest.contractor.email}`
        : manifest.contractor.email,
    );
    field("Accès jusqu'au", date(manifest.accessExpiresAt));

    heading("Document et copie");
    field(
      "Empreinte SHA-256 du fichier original",
      manifest.copy.sourceSha256,
      true,
    );
    field("Identifiant du fichier", manifest.copy.sourceFileId);
    field("Identifiant de la copie", manifest.copy.previewId);
    field("Identifiant du marquage invisible", manifest.copy.markId, true);
    field("Nombre de pages", String(manifest.copy.pageCount));

    heading("Preuves");
    field(
      "Validation par passkey (WebAuthn, vérification de l'utilisateur exigée)",
      `Identifiant de la clé ${issuance.credentialId}, algorithme COSE ${issuance.credentialAlgorithm}. Le défi signé est l'empreinte SHA-256 du manifeste canonique : ${issuance.manifestHash}`,
    );
    field("Empreinte de l'enregistrement", issuance.recordHash, true);
    field(
      "Horodatage RFC 3161",
      issuance.timestampToken
        ? `Jeton délivré par l'autorité d'horodatage, reçu le ${date(issuance.timestampedAt)}.`
        : "Aucun jeton : aucune autorité d'horodatage n'était disponible.",
    );

    heading("Journal de consultation");
    const opened = events.filter((event) => event.kind === "OPENED");
    const pages = events.filter((event) => event.kind === "PAGE");
    text(
      `${opened.length} ouverture(s) et ${pages.length} requête(s) de page autorisée(s) au ${date(generatedAt)}. Le préchargement peut précéder l'affichage et ne prouve pas la lecture. Journal chaîné par empreintes ${chainValid ? "intègre" : "ROMPU"} à la génération, ${anchorCount} ancrage(s) horodaté(s) couvrant cette copie.`,
    );
    for (const event of events.slice(0, 200)) {
      const label =
        event.kind === "PAGE"
          ? `page ${(event.pageIndex ?? 0) + 1} demandée`
          : event.kind === "OPENED"
            ? "copie ouverte"
            : event.kind === "ISSUED"
              ? "copie remise"
              : event.kind === "REVOKED"
                ? "accès révoqué"
                : event.kind === "VAULT"
                  ? "preuves consultées depuis le coffre-fort de la plateforme"
                  : "copie supprimée";
      text(`${date(event.at)} - ${label}`, { size: 8.5, color: 0.3 });
    }
    if (events.length > 200) {
      text(
        `Et ${events.length - 200} autre(s) événement(s) dans le fichier joint.`,
        {
          size: 8.5,
          color: 0.3,
        },
      );
    }

    // Kept on one page: a split list of steps reads as two unrelated ones.
    const steps = [
      VERIFICATION_INTRO,
      ...VERIFICATION_STEPS.map((step, index) => `${index + 1}. ${step}`),
    ];
    const stepsHeight =
      40 +
      steps.reduce(
        (total, step) => total + wrap(step, 8.5, 495).length * 12.5 + 4,
        0,
      );
    if (y - stepsHeight < 50) {
      page = pdfDoc.addPage([595.28, 841.89]);
      y = height - 56;
    }
    heading("Vérifier sans PrivCloud");
    for (const step of steps) {
      text(step, { size: 8.5, color: 0.3 });
      y -= 4;
    }
    text(
      `Certificat généré le ${date(generatedAt)}. Ce document ne contient ni le titre ni le contenu du fichier : ils restent chiffrés de bout en bout.`,
      { size: 8, color: 0.45 },
    );
    await pdfDoc.attach(evidence, "preuve.json", {
      mimeType: "application/json",
      description: "Manifeste, signature WebAuthn, horodatages et journal",
      creationDate: generatedAt,
      modificationDate: generatedAt,
    });
    return Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
  }

  // ===========================================================================
  // RETENTION
  // ===========================================================================

  /**
   * Erases the register and journal of a team before the retention ends, on
   * the documented instruction of the customer. The vault only offers it once
   * the team itself is gone.
   */
  async eraseTeam(teamId: string) {
    const [issuances, events, anchors] = await this.prisma.$transaction(
      async (tx) => {
        const records = await tx.teamExternalIssuance.findMany({
          where: { teamId },
          select: { id: true },
        });
        await tx.signingTimestamp.deleteMany({
          where: {
            scope: "forensic",
            documentId: { in: [teamId, ...records.map((record) => record.id)] },
          },
        });
        return [
          await tx.teamExternalIssuance.deleteMany({ where: { teamId } }),
          await tx.teamExternalAuditEvent.deleteMany({ where: { teamId } }),
          await tx.teamExternalAuditAnchor.deleteMany({ where: { teamId } }),
        ];
      },
    );
    return {
      issuances: issuances.count,
      events: events.count,
      anchors: anchors.count,
    };
  }

  /** Abandoned approvals and evidence older than the audit retention. */
  async purge(now = new Date()) {
    try {
      const retention = new Date(now.getTime() - EXTERNAL_AUDIT_RETENTION_MS);
      await this.prisma.signingTimestamp.deleteMany({
        where: { scope: "forensic", createdAt: { lt: retention } },
      });
      await this.prisma.teamExternalIssuance.deleteMany({
        where: {
          OR: [
            { createdAt: { lt: retention } },
            {
              status: "APPROVED",
              createdAt: {
                lt: new Date(now.getTime() - EXTERNAL_UPLOAD_TTL_MS),
              },
            },
          ],
        },
      });
      await this.prisma.teamExternalAuditEvent.deleteMany({
        where: { at: { lt: retention } },
      });
      await this.prisma.teamExternalAuditAnchor.deleteMany({
        where: { createdAt: { lt: retention } },
      });
      await this.prisma.passkeyChallenge.deleteMany({
        where: { expiresAt: { lt: now } },
      });
      await this.prisma.evidenceVaultSession.deleteMany({
        where: { expiresAt: { lt: now } },
      });
    } catch {
      this.logger.warn("Could not purge contractor audit evidence");
    }
  }
}
