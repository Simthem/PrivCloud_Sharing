import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import * as crypto from "crypto";
import { User } from "@prisma/client";
import { ConfigService } from "src/config/config.service";
import { FileService } from "src/file/file.service";
import { PrismaService } from "src/prisma/prisma.service";
import {
  PreparePasskeyActionDTO,
  RejectDocumentDTO,
  SignDocumentDTO,
} from "./dto/signDocument.dto";
import { resolveSigningIdentityProof } from "./signing-identity.util";
import { appendSignatureAuditEvent } from "./signing-audit.util";

const CEREMONY_TTL_MS = 5 * 60_000;
const WEBAUTHN_PROTOCOL = "privcloud-signing-webauthn-v1";

type ActionPurpose = "SIGN" | "REJECT";

export type VerifiedPasskeyEvidence = {
  authenticationMethod: "WEBAUTHN";
  signingIntentHash: string;
  signedDocumentHash: string;
  webauthnCredentialId: string;
  webauthnAssertion: string;
  webauthnUserVerified: boolean;
  webauthnDeviceType: string;
  webauthnBackedUp: boolean;
};

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizedFieldValues(
  values: { fieldId: string; value: string }[] | undefined,
) {
  return [...(values || [])]
    .map((field) => ({ fieldId: field.fieldId, value: field.value }))
    .sort((left, right) => left.fieldId.localeCompare(right.fieldId));
}

export function buildSigningIntentHash(input: {
  purpose: ActionPurpose;
  documentId: string;
  recipientId: string;
  sourceDocumentHash: string;
  expiresAt: Date | null;
  signatureData?: string;
  signatureType?: string;
  fieldValues?: { fieldId: string; value: string }[];
  reason?: string;
}): string {
  const manifest = {
    protocol: WEBAUTHN_PROTOCOL,
    purpose: input.purpose,
    documentId: input.documentId,
    recipientId: input.recipientId,
    sourceDocumentHash: input.sourceDocumentHash,
    requestExpiresAt: input.expiresAt?.toISOString() || null,
    signatureType: input.signatureType || null,
    signatureDataHash:
      input.signatureData === undefined ? null : sha256(input.signatureData),
    fieldValues: normalizedFieldValues(input.fieldValues),
    rejectionReason: input.reason?.trim() || null,
    consent:
      input.purpose === "SIGN"
        ? "I have reviewed the identified document and explicitly consent to sign it."
        : "I explicitly reject the identified document.",
  };
  return sha256(JSON.stringify(manifest));
}

@Injectable()
export class SigningWebAuthnService {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private fileService: FileService,
  ) {}

  async beginRegistration(signingToken: string, user: User) {
    const recipient = await this.getReinforcedRecipientForUser(
      signingToken,
      user.id,
    );
    await this.assertCurrentIdentityProof(user.id, recipient.id);

    const passkeys = await this.prisma.signingPasskey.findMany({
      where: { userId: user.id },
      select: { credentialId: true, transports: true },
    });
    const { rpID } = this.getRelyingParty();
    const options = await generateRegistrationOptions({
      rpName: "PrivCloud Sharing",
      rpID,
      userID: new TextEncoder().encode(user.id),
      userName: user.email,
      userDisplayName: user.username || user.email,
      timeout: CEREMONY_TTL_MS,
      attestationType: "none",
      supportedAlgorithmIDs: [-7, -257],
      excludeCredentials: passkeys.map((passkey) => ({
        id: passkey.credentialId,
        transports: this.parseTransports(passkey.transports),
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
    });

    await this.expirePreviousChallenges(user.id, recipient.id, "REGISTER");
    const challenge = await this.prisma.signingWebAuthnChallenge.create({
      data: {
        purpose: "REGISTER",
        challenge: options.challenge,
        expiresAt: new Date(Date.now() + CEREMONY_TTL_MS),
        userId: user.id,
        recipientId: recipient.id,
      },
      select: { id: true },
    });

    return { challengeId: challenge.id, options };
  }

  async finishRegistration(
    signingToken: string,
    user: User,
    challengeId: string,
    response: RegistrationResponseJSON,
  ) {
    const recipient = await this.getReinforcedRecipientForUser(
      signingToken,
      user.id,
    );
    await this.assertCurrentIdentityProof(user.id, recipient.id);
    const challenge = await this.getUsableChallenge(
      challengeId,
      "REGISTER",
      recipient.id,
      user.id,
    );
    const { rpID, expectedOrigin } = this.getRelyingParty();

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin,
        expectedRPID: rpID,
        requireUserPresence: true,
        requireUserVerification: true,
        supportedAlgorithmIDs: [-7, -257],
      });
    } catch {
      throw new BadRequestException("Invalid passkey registration response");
    }

    if (!verification.verified || !verification.registrationInfo) {
      throw new BadRequestException(
        "Passkey registration could not be verified",
      );
    }

    const info = verification.registrationInfo;
    const alreadyRegistered = await this.prisma.signingPasskey.findUnique({
      where: { credentialId: info.credential.id },
      select: { userId: true },
    });
    if (alreadyRegistered) {
      throw new ConflictException("This passkey is already registered");
    }

    const consumed = await this.prisma.signingWebAuthnChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw new ConflictException("Passkey challenge was already consumed");
    }

    await this.prisma.signingPasskey.create({
      data: {
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey),
        counter: BigInt(info.credential.counter),
        transports: response.response.transports?.length
          ? JSON.stringify(response.response.transports)
          : null,
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        aaguid: info.aaguid || null,
        userId: user.id,
      },
    });

    await this.createAuditEvent(
      recipient.documentId,
      "PASSKEY_REGISTERED",
      user.email,
      {
        credentialIdHash: sha256(info.credential.id),
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        identityVerificationMethod: recipient.identityVerificationMethod,
      },
    );

    return { verified: true };
  }

  async beginAction(signingToken: string, dto: PreparePasskeyActionDTO) {
    const recipient = await this.getReinforcedRecipient(signingToken);
    this.assertRecipientCanAct(recipient);
    const passkeys = await this.prisma.signingPasskey.findMany({
      where: { userId: recipient.userId! },
    });
    if (passkeys.length === 0) {
      throw new ForbiddenException(
        "A passkey must be registered from the verified recipient account",
      );
    }

    const sourceDocumentHash = await this.hashSourceDocument(
      recipient.document.originalFileKey,
    );
    const intentHash = buildSigningIntentHash({
      purpose: dto.action,
      documentId: recipient.documentId,
      recipientId: recipient.id,
      sourceDocumentHash,
      expiresAt: recipient.document.expiresAt,
      signatureData: dto.signatureData,
      signatureType: dto.signatureType,
      fieldValues: dto.fieldValues,
      reason: dto.reason,
    });
    const nonce = crypto.randomBytes(32);
    const transactionChallenge = crypto
      .createHash("sha256")
      .update(nonce)
      .update(Buffer.from(intentHash, "hex"))
      .digest("base64url");
    const { rpID } = this.getRelyingParty();
    const options = await generateAuthenticationOptions({
      rpID,
      challenge: transactionChallenge,
      timeout: CEREMONY_TTL_MS,
      userVerification: "required",
      allowCredentials: passkeys.map((passkey) => ({
        id: passkey.credentialId,
        transports: this.parseTransports(passkey.transports),
      })),
    });

    await this.expirePreviousChallenges(
      recipient.userId!,
      recipient.id,
      dto.action,
    );
    const challenge = await this.prisma.signingWebAuthnChallenge.create({
      data: {
        purpose: dto.action,
        challenge: options.challenge,
        intentHash,
        sourceDocumentHash,
        expiresAt: new Date(Date.now() + CEREMONY_TTL_MS),
        userId: recipient.userId!,
        recipientId: recipient.id,
      },
      select: { id: true },
    });

    return {
      challengeId: challenge.id,
      intentHash,
      documentHash: sourceDocumentHash,
      options,
    };
  }

  async verifySignAction(
    signingToken: string,
    dto: SignDocumentDTO,
  ): Promise<VerifiedPasskeyEvidence> {
    if (!dto.passkeyChallengeId || !dto.passkeyResponse) {
      throw new ForbiddenException("A fresh passkey confirmation is required");
    }
    return this.verifyAction(
      signingToken,
      "SIGN",
      {
        purpose: "SIGN",
        signatureData: dto.signatureData,
        signatureType: dto.signatureType,
        fieldValues: dto.fieldValues,
      },
      dto.passkeyChallengeId,
      dto.passkeyResponse as unknown as AuthenticationResponseJSON,
    );
  }

  async verifyRejectAction(
    signingToken: string,
    dto: RejectDocumentDTO,
  ): Promise<VerifiedPasskeyEvidence> {
    if (!dto.passkeyChallengeId || !dto.passkeyResponse) {
      throw new ForbiddenException("A fresh passkey confirmation is required");
    }
    return this.verifyAction(
      signingToken,
      "REJECT",
      { purpose: "REJECT", reason: dto.reason },
      dto.passkeyChallengeId,
      dto.passkeyResponse as unknown as AuthenticationResponseJSON,
    );
  }

  private async verifyAction(
    signingToken: string,
    purpose: ActionPurpose,
    payload: {
      purpose: ActionPurpose;
      signatureData?: string;
      signatureType?: string;
      fieldValues?: { fieldId: string; value: string }[];
      reason?: string;
    },
    challengeId: string,
    response: AuthenticationResponseJSON,
  ): Promise<VerifiedPasskeyEvidence> {
    const recipient = await this.getReinforcedRecipient(signingToken);
    this.assertRecipientCanAct(recipient);
    const challenge = await this.getUsableChallenge(
      challengeId,
      purpose,
      recipient.id,
      recipient.userId!,
    );
    const credential = await this.prisma.signingPasskey.findFirst({
      where: { credentialId: response.id, userId: recipient.userId! },
    });
    if (!credential) throw new ForbiddenException("Unknown passkey");

    const currentSourceHash = await this.hashSourceDocument(
      recipient.document.originalFileKey,
    );
    if (currentSourceHash !== challenge.sourceDocumentHash) {
      throw new ConflictException(
        "The document changed after confirmation began",
      );
    }
    const currentIntentHash = buildSigningIntentHash({
      purpose,
      documentId: recipient.documentId,
      recipientId: recipient.id,
      sourceDocumentHash: currentSourceHash,
      expiresAt: recipient.document.expiresAt,
      signatureData: payload.signatureData,
      signatureType: payload.signatureType,
      fieldValues: payload.fieldValues,
      reason: payload.reason,
    });
    if (currentIntentHash !== challenge.intentHash) {
      throw new ConflictException(
        "The signing payload changed after confirmation began",
      );
    }

    const { rpID, expectedOrigin } = this.getRelyingParty();
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: credential.credentialId,
          publicKey: new Uint8Array(credential.publicKey),
          counter: Number(credential.counter),
          transports: this.parseTransports(credential.transports),
        },
      });
    } catch {
      throw new BadRequestException("Invalid passkey assertion");
    }
    if (
      !verification.verified ||
      !verification.authenticationInfo.userVerified
    ) {
      throw new ForbiddenException("Passkey user verification is required");
    }

    const consumed = await this.prisma.signingWebAuthnChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw new ConflictException("Passkey challenge was already consumed");
    }
    await this.prisma.signingPasskey.update({
      where: { id: credential.id },
      data: {
        counter: BigInt(verification.authenticationInfo.newCounter),
        deviceType: verification.authenticationInfo.credentialDeviceType,
        backedUp: verification.authenticationInfo.credentialBackedUp,
        lastUsedAt: new Date(),
      },
    });

    return {
      authenticationMethod: "WEBAUTHN",
      signingIntentHash: currentIntentHash,
      signedDocumentHash: currentSourceHash,
      webauthnCredentialId: credential.credentialId,
      webauthnAssertion: JSON.stringify(response),
      webauthnUserVerified: true,
      webauthnDeviceType: verification.authenticationInfo.credentialDeviceType,
      webauthnBackedUp: verification.authenticationInfo.credentialBackedUp,
    };
  }

  private async assertCurrentIdentityProof(
    userId: string,
    recipientId: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        emailVerifiedAt: true,
        ldapDN: true,
        oAuthUsers: { select: { provider: true }, take: 1 },
      },
    });
    if (!user) throw new NotFoundException("User not found");
    const proof = resolveSigningIdentityProof(user);
    if (!proof) {
      throw new ForbiddenException(
        "The recipient account must have a verified email, LDAP identity or OIDC identity",
      );
    }
    await this.prisma.signatureRecipient.update({
      where: { id: recipientId },
      data: {
        identityVerificationMethod: proof.method,
        identityVerifiedAt: proof.verifiedAt,
      },
    });
  }

  private async getReinforcedRecipientForUser(
    signingToken: string,
    userId: string,
  ) {
    const recipient = await this.getReinforcedRecipient(signingToken);
    if (recipient.userId !== userId) {
      throw new ForbiddenException(
        "Sign in with the PrivCloud account assigned to this request",
      );
    }
    return recipient;
  }

  private async getReinforcedRecipient(signingToken: string) {
    const recipient = await this.prisma.signatureRecipient.findUnique({
      where: { signingToken },
      include: { document: true },
    });
    if (!recipient) throw new NotFoundException("Invalid signing link");
    if (
      recipient.document.fileDeletedAt ||
      recipient.document.fileId === null
    ) {
      throw new NotFoundException(
        "The source file was deleted; this signing link is no longer valid",
      );
    }
    if (recipient.document.signatureLevel !== "REINFORCED") {
      throw new BadRequestException("This request does not require a passkey");
    }
    if (!recipient.userId || !recipient.identityVerifiedAt) {
      throw new ForbiddenException("The recipient identity is not verified");
    }
    return recipient;
  }

  private assertRecipientCanAct(recipient: {
    status: string;
    document: { status: string; expiresAt: Date | null };
  }) {
    if (recipient.document.status !== "PENDING") {
      throw new ForbiddenException("This signing request is no longer pending");
    }
    if (
      recipient.document.expiresAt &&
      recipient.document.expiresAt < new Date()
    ) {
      throw new ForbiddenException("This signing request has expired");
    }
    if (!["PENDING", "VIEWED"].includes(recipient.status)) {
      throw new ForbiddenException("This recipient has already acted");
    }
  }

  private async getUsableChallenge(
    id: string,
    purpose: string,
    recipientId: string,
    userId: string,
  ) {
    const challenge = await this.prisma.signingWebAuthnChallenge.findFirst({
      where: { id, purpose, recipientId, userId, consumedAt: null },
    });
    if (!challenge || challenge.expiresAt < new Date()) {
      throw new BadRequestException("Passkey challenge is invalid or expired");
    }
    return challenge;
  }

  private async expirePreviousChallenges(
    userId: string,
    recipientId: string,
    purpose: string,
  ) {
    await this.prisma.signingWebAuthnChallenge.updateMany({
      where: { userId, recipientId, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  }

  private async hashSourceDocument(fileKey: string): Promise<string> {
    return sha256(await this.fileService.getFileByKey(fileKey));
  }

  private parseTransports(value: string | null) {
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private getRelyingParty() {
    const configured = this.configService.get("general.appUrl") as string;
    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      throw new Error(
        "general.appUrl must be a valid absolute URL for WebAuthn",
      );
    }
    return { rpID: url.hostname, expectedOrigin: url.origin };
  }

  private async createAuditEvent(
    documentId: string,
    eventType: string,
    actor: string,
    metadata: Record<string, unknown>,
  ) {
    await appendSignatureAuditEvent(this.prisma, {
      documentId,
      eventType,
      actor,
      metadata,
    });
  }
}
