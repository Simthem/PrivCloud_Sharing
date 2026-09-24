import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
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
import {
  cose,
  decodeCredentialPublicKey,
} from "@simplewebauthn/server/helpers";
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
import { PdfSigningService } from "./pdf-signing.service";
import { collectRecipientFieldValues } from "./signing-field-values.util";
import {
  buildSigningTransactionManifest,
  buildTransactionChallenge,
  transactionChallengeBytes,
  canonicalJson,
  hashSigningTransactionManifest,
  parseAuthenticatorEvidence,
  sha256Hex,
} from "./signing-evidence.util";

const CEREMONY_TTL_MS = 5 * 60_000;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  webauthnPublicKey: string;
  webauthnAlgorithm: number;
  webauthnChallenge: string;
  webauthnChallengeNonce: string;
  webauthnTransactionManifest: string;
  webauthnOrigin: string;
  webauthnRpId: string;
  webauthnSignCount: bigint;
  webauthnClientDataJSON: string;
  webauthnAuthenticatorData: string;
  webauthnSignature: string;
  webauthnUserHandle: string | null;
  webauthnUserPresent: boolean;
  webauthnBackupEligible: boolean;
  webauthnIdentitySnapshot: string;
  webauthnEnrollmentRecord: string;
  webauthnEnrollmentSignature: string;
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
  signerAccountId?: string;
}): string {
  return hashSigningTransactionManifest(
    buildSigningTransactionManifest({
      action: input.purpose,
      documentId: input.documentId,
      recipientId: input.recipientId,
      signerAccountId: input.signerAccountId || "unassigned-standard-recipient",
      sourceDocumentHash: input.sourceDocumentHash,
      expiresAt: input.expiresAt,
      signatureData: input.signatureData,
      signatureType: input.signatureType,
      fieldValues: normalizedFieldValues(input.fieldValues),
      reason: input.reason,
    }),
  );
}

@Injectable()
export class SigningWebAuthnService {
  private readonly logger = new Logger(SigningWebAuthnService.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private fileService: FileService,
    private pdfSigningService: PdfSigningService,
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

    const account = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: {
        id: true,
        username: true,
        email: true,
        emailVerifiedAt: true,
        emailVerificationSource: true,
        ldapDN: true,
        oAuthUsers: {
          select: {
            provider: true,
            providerUserId: true,
            providerUsername: true,
          },
        },
      },
    });
    const decodedPublicKey = decodeCredentialPublicKey(
      info.credential.publicKey,
    );
    const publicKeyAlgorithm = decodedPublicKey.get(cose.COSEKEYS.alg);
    if (publicKeyAlgorithm === undefined) {
      throw new BadRequestException("Passkey public-key algorithm is missing");
    }
    const enrolledAt = new Date();
    const identitySnapshot = canonicalJson({
      privcloudUserId: account.id,
      username: account.username,
      email: account.email,
      emailVerifiedAt: account.emailVerifiedAt?.toISOString() || null,
      emailVerificationSource: account.emailVerificationSource,
      ldapDn: account.ldapDN,
      oidcAccounts: account.oAuthUsers.map((oauth) => ({
        provider: oauth.provider,
        subject: oauth.providerUserId,
        username: oauth.providerUsername,
      })),
      verificationMethod: recipient.identityVerificationMethod,
      verifiedAt: recipient.identityVerifiedAt?.toISOString() || null,
    });
    const enrollmentRecord = canonicalJson({
      protocol: "privcloud-signing-passkey-enrollment-v1",
      credentialId: info.credential.id,
      publicKeyCoseBase64Url: Buffer.from(info.credential.publicKey).toString(
        "base64url",
      ),
      publicKeyAlgorithm,
      aaguid: info.aaguid || null,
      deviceType: info.credentialDeviceType,
      backupEligible: info.credentialDeviceType === "multiDevice",
      backedUp: info.credentialBackedUp,
      rpId: rpID,
      origin: expectedOrigin,
      enrolledAt: enrolledAt.toISOString(),
      identity: JSON.parse(identitySnapshot),
    });
    const enrollmentSignature = await this.pdfSigningService.signDigest(
      Buffer.from(sha256Hex(enrollmentRecord), "hex"),
      { scope: "enrollment", webauthnCredentialId: info.credential.id },
    );

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
        publicKeyAlgorithm,
        rpId: rpID,
        origin: expectedOrigin,
        registrationResponse: canonicalJson(response),
        identitySnapshot,
        enrollmentRecord,
        enrollmentSignature: enrollmentSignature.toString("base64"),
        enrolledAt,
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

    const storageDocumentHash = await this.hashSourceDocument(
      recipient.document.originalFileKey,
    );
    const sourceDocumentHash = recipient.document.isE2EEncrypted
      ? dto.displayedDocumentHash?.toLowerCase()
      : storageDocumentHash;
    if (!sourceDocumentHash) {
      throw new BadRequestException(
        "The SHA-256 hash of the displayed E2E document is required",
      );
    }
    await this.assertSameDisplayedSource(recipient, sourceDocumentHash);
    if (dto.action === "SIGN") {
      await this.pdfSigningService.assertRenderableSignature(
        dto.signatureData || "",
        dto.signatureType || "",
      );
    }
    // Same normalization as the persisted rows, so the signer approves the
    // exact values the final PDF will show.
    const committedFieldValues =
      dto.action === "SIGN"
        ? collectRecipientFieldValues(
            recipient.id,
            recipient.document.fields,
            dto.fieldValues || [],
          ).map(({ fieldId, value }) => ({ fieldId, value }))
        : undefined;
    const manifest = buildSigningTransactionManifest({
      action: dto.action,
      documentId: recipient.documentId,
      recipientId: recipient.id,
      signerAccountId: recipient.userId!,
      sourceDocumentHash,
      storageDocumentHash: recipient.document.isE2EEncrypted
        ? storageDocumentHash
        : undefined,
      expiresAt: recipient.document.expiresAt,
      signatureData: dto.signatureData,
      signatureType: dto.signatureType,
      fieldValues: committedFieldValues,
      reason: dto.reason,
    });
    const transactionManifest = canonicalJson(manifest);
    const intentHash = hashSigningTransactionManifest(manifest);
    const challengeNonce = crypto.randomBytes(32).toString("base64url");
    const transactionChallenge = buildTransactionChallenge(
      intentHash,
      challengeNonce,
    );
    const { rpID } = this.getRelyingParty();
    const options = await generateAuthenticationOptions({
      rpID,
      // The bytes, not the string: a string would be UTF-8 encoded again and
      // the signed clientDataJSON would no longer carry the transaction
      // challenge an independent verifier recomputes.
      challenge: transactionChallengeBytes(transactionChallenge),
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
        sourceDocumentHash: storageDocumentHash,
        transactionManifest,
        challengeNonce,
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
        displayedDocumentHash: dto.displayedDocumentHash,
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
      displayedDocumentHash?: string;
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
    if (
      credential.publicKeyAlgorithm === null ||
      !credential.identitySnapshot ||
      !credential.enrollmentRecord ||
      !credential.enrollmentSignature
    ) {
      throw new ForbiddenException(
        "This legacy passkey has no immutable enrollment proof; register a new signing passkey",
      );
    }

    const currentStorageHash = await this.hashSourceDocument(
      recipient.document.originalFileKey,
    );
    if (currentStorageHash !== challenge.sourceDocumentHash) {
      throw new ConflictException(
        "The document changed after confirmation began",
      );
    }
    const signedDocumentHash = recipient.document.isE2EEncrypted
      ? payload.displayedDocumentHash?.toLowerCase()
      : currentStorageHash;
    if (!signedDocumentHash) {
      throw new BadRequestException(
        "The SHA-256 hash of the displayed E2E document is required",
      );
    }
    await this.assertSameDisplayedSource(recipient, signedDocumentHash);
    const currentManifest = buildSigningTransactionManifest({
      action: purpose,
      documentId: recipient.documentId,
      recipientId: recipient.id,
      signerAccountId: recipient.userId!,
      sourceDocumentHash: signedDocumentHash,
      storageDocumentHash: recipient.document.isE2EEncrypted
        ? currentStorageHash
        : undefined,
      expiresAt: recipient.document.expiresAt,
      signatureData: payload.signatureData,
      signatureType: payload.signatureType,
      fieldValues: payload.fieldValues,
      reason: payload.reason,
    });
    const currentTransactionManifest = canonicalJson(currentManifest);
    const currentIntentHash = hashSigningTransactionManifest(currentManifest);
    if (currentIntentHash !== challenge.intentHash) {
      throw new ConflictException(
        "The signing payload changed after confirmation began",
      );
    }
    if (
      currentTransactionManifest !== challenge.transactionManifest ||
      !challenge.challengeNonce ||
      buildTransactionChallenge(currentIntentHash, challenge.challengeNonce) !==
        challenge.challenge
    ) {
      throw new ConflictException(
        "The persisted signing transaction is inconsistent",
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
    const rawEvidence = parseAuthenticatorEvidence(response);
    if (!rawEvidence.userPresent || !rawEvidence.userVerified) {
      throw new ForbiddenException(
        "Passkey presence and user verification are required",
      );
    }
    const clientData = JSON.parse(
      Buffer.from(rawEvidence.clientDataJSON, "base64url").toString("utf8"),
    ) as { challenge?: string; origin?: string; type?: string };
    if (
      clientData.challenge !== challenge.challenge ||
      clientData.origin !== expectedOrigin ||
      clientData.type !== "webauthn.get"
    ) {
      throw new BadRequestException(
        "Passkey client data does not match the transaction",
      );
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
      signedDocumentHash,
      webauthnCredentialId: credential.credentialId,
      webauthnAssertion: JSON.stringify(response),
      webauthnUserVerified: true,
      webauthnDeviceType: verification.authenticationInfo.credentialDeviceType,
      webauthnBackedUp: verification.authenticationInfo.credentialBackedUp,
      webauthnPublicKey: Buffer.from(credential.publicKey).toString(
        "base64url",
      ),
      webauthnAlgorithm: credential.publicKeyAlgorithm,
      webauthnChallenge: challenge.challenge,
      webauthnChallengeNonce: challenge.challengeNonce!,
      webauthnTransactionManifest: challenge.transactionManifest!,
      webauthnOrigin: expectedOrigin,
      webauthnRpId: rpID,
      webauthnSignCount: BigInt(rawEvidence.signCount),
      webauthnClientDataJSON: rawEvidence.clientDataJSON,
      webauthnAuthenticatorData: rawEvidence.authenticatorData,
      webauthnSignature: rawEvidence.signature,
      webauthnUserHandle: rawEvidence.userHandle,
      webauthnUserPresent: rawEvidence.userPresent,
      webauthnBackupEligible: rawEvidence.backupEligible,
      webauthnIdentitySnapshot: credential.identitySnapshot,
      webauthnEnrollmentRecord: credential.enrollmentRecord,
      webauthnEnrollmentSignature: credential.enrollmentSignature,
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
        emailVerificationSource: true,
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
      include: { document: { include: { fields: true } } },
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

  /** E2E signers must all commit to the same decrypted source bytes. */
  private async assertSameDisplayedSource(
    recipient: {
      id: string;
      documentId: string;
      document: { isE2EEncrypted: boolean };
    },
    displayedDocumentHash: string,
  ) {
    if (!recipient.document.isE2EEncrypted) return;
    const previous = await this.prisma.signatureRecipient.findFirst({
      where: {
        documentId: recipient.documentId,
        id: { not: recipient.id },
        signedDocumentHash: { not: null },
      },
      select: { signedDocumentHash: true },
    });
    if (previous && previous.signedDocumentHash !== displayedDocumentHash) {
      throw new ConflictException(
        "The displayed document differs from the one approved by previous signers",
      );
    }
  }

  private async hashSourceDocument(fileKey: string): Promise<string> {
    return sha256(await this.fileService.getFileByKey(fileKey));
  }

  /** Signing passkeys of an account, without their key material. */
  async listPasskeys(userId: string) {
    const passkeys = await this.prisma.signingPasskey.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        createdAt: true,
        lastUsedAt: true,
        deviceType: true,
        backedUp: true,
        transports: true,
      },
    });
    return passkeys.map(({ transports, ...passkey }) => ({
      ...passkey,
      transports: this.parseTransports(transports) ?? [],
    }));
  }

  /**
   * Removes a passkey the account no longer holds. Signatures already given
   * keep their evidence: the public key and the sealed enrollment record were
   * copied on the signer when the passkey was used.
   */
  async deletePasskey(userId: string, passkeyId: string) {
    const { count } = await this.prisma.signingPasskey.deleteMany({
      where: { id: passkeyId, userId },
    });
    if (count !== 1) throw new NotFoundException("Passkey not found");
    this.logger.log(`User ${userId} removed the signing passkey ${passkeyId}`);
  }

  /** Administrator reset: the account enrolls a new passkey at its next signature. */
  async resetPasskeys(userId: string, administratorEmail: string) {
    const { count } = await this.prisma.signingPasskey.deleteMany({
      where: { userId },
    });
    this.logger.warn(
      `Administrator ${administratorEmail} removed the ${count} signing passkey(s) of user ${userId}`,
    );
    return { deleted: count };
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
