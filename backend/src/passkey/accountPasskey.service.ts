import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
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
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { User } from "@prisma/client";
import { ConfigService } from "src/config/config.service";
import { PrismaService } from "src/prisma/prisma.service";
import { PasskeyResponseDTO } from "./dto/passkey.dto";

export const PASSKEY_CEREMONY_TTL_MS = 5 * 60 * 1000;

export type IssuanceAssertion = {
  manifest: string;
  manifestHash: string;
  credentialId: string;
  credentialPublicKey: string;
  credentialAlgorithm: number;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
  userHandle: string | null;
};

type StoredCredential = {
  table: "account" | "signing";
  id: string;
  userId: string;
  credentialId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: bigint;
  transports: string | null;
};

type Ceremony =
  | "REGISTER"
  | "ISSUE"
  | "LOGIN"
  | "VAULT"
  | "TEAM_EVIDENCE"
  | "STEP_UP";

function parseTransports(value: string | null) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? (parsed as AuthenticatorTransportFuture[])
      : undefined;
  } catch {
    return undefined;
  }
}

/** A copy backed by a plain ArrayBuffer, as @simplewebauthn expects. */
function bytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.length);
  copy.set(value);
  return copy;
}

function coseAlgorithm(publicKey: Uint8Array): number {
  const algorithm = decodeCredentialPublicKey(bytes(publicKey)).get(
    cose.COSEKEYS.alg,
  );
  if (typeof algorithm !== "number") {
    throw new BadRequestException("Unsupported passkey public key");
  }
  return algorithm;
}

/**
 * User handle each kind of passkey was created with. Signing passkeys use
 * the account id itself, account passkeys a distinct handle so that an
 * authenticator never replaces one with the other.
 */
function expectedUserHandle(credential: StoredCredential) {
  return Buffer.from(
    credential.table === "signing"
      ? credential.userId
      : `account:${credential.userId}`,
  ).toString("base64url");
}

/**
 * Passkeys of an account: those added from the account settings and those
 * enrolled during an electronic signature. Both sign in and approve the
 * copies issued to contractors.
 */
@Injectable()
export class AccountPasskeyService {
  private readonly logger = new Logger(AccountPasskeyService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  private relyingParty() {
    const url = new URL(this.config.get("general.appUrl") as string);
    return { rpID: url.hostname, expectedOrigin: url.origin };
  }

  async list(user: User) {
    const [passkeys, signingPasskeys] = await Promise.all([
      this.prisma.accountPasskey.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          createdAt: true,
          lastUsedAt: true,
          deviceType: true,
          backedUp: true,
        },
      }),
      this.prisma.signingPasskey.count({ where: { userId: user.id } }),
    ]);
    return { passkeys, signingPasskeys };
  }

  private toStored(
    table: StoredCredential["table"],
    passkey: {
      id: string;
      userId: string;
      credentialId: string;
      publicKey: Uint8Array;
      counter: bigint;
      transports: string | null;
    },
  ): StoredCredential {
    return {
      table,
      id: passkey.id,
      userId: passkey.userId,
      credentialId: passkey.credentialId,
      publicKey: bytes(passkey.publicKey),
      counter: passkey.counter,
      transports: passkey.transports,
    };
  }

  private async credentials(userId: string): Promise<StoredCredential[]> {
    const [account, signing] = await Promise.all([
      this.prisma.accountPasskey.findMany({ where: { userId } }),
      this.prisma.signingPasskey.findMany({ where: { userId } }),
    ]);
    return [
      ...account.map((passkey) => this.toStored("account", passkey)),
      ...signing.map((passkey) => this.toStored("signing", passkey)),
    ];
  }

  private async credentialById(
    credentialId: string,
  ): Promise<StoredCredential | null> {
    if (typeof credentialId !== "string" || credentialId.length > 1024) {
      return null;
    }
    const account = await this.prisma.accountPasskey.findUnique({
      where: { credentialId },
    });
    if (account) return this.toStored("account", account);
    const signing = await this.prisma.signingPasskey.findUnique({
      where: { credentialId },
    });
    return signing ? this.toStored("signing", signing) : null;
  }

  private async usableChallenge(
    id: string,
    userId: string | null,
    purpose: Ceremony,
    previewId?: string,
  ) {
    const challenge = await this.prisma.passkeyChallenge.findFirst({
      where: {
        id,
        userId,
        purpose,
        consumedAt: null,
        ...(previewId ? { previewId } : {}),
      },
    });
    if (!challenge || challenge.expiresAt <= new Date()) {
      throw new BadRequestException("Passkey challenge is invalid or expired");
    }
    return challenge;
  }

  /** Single use, even when two answers race. */
  private async consume(challengeId: string) {
    const consumed = await this.prisma.passkeyChallenge.updateMany({
      where: { id: challengeId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw new BadRequestException("Passkey challenge is invalid or expired");
    }
  }

  private async replaceChallenges(
    userId: string,
    purpose: Ceremony,
    previewId?: string,
  ) {
    const now = new Date();
    await this.prisma.passkeyChallenge.deleteMany({
      where: { userId, expiresAt: { lt: now } },
    });
    await this.prisma.passkeyChallenge.updateMany({
      where: {
        userId,
        purpose,
        consumedAt: null,
        ...(previewId ? { previewId } : {}),
      },
      data: { consumedAt: now },
    });
  }

  /**
   * Checks an assertion against a stored credential and moves its counter.
   * Only the site's own origin is accepted unless `origins` says otherwise.
   */
  private async verifyAssertion(
    challenge: string,
    credential: StoredCredential,
    response: AuthenticationResponseJSON,
    origins?: string[],
  ) {
    const { rpID, expectedOrigin } = this.relyingParty();
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origins ?? expectedOrigin,
        expectedRPID: rpID,
        credential: {
          id: credential.credentialId,
          publicKey: credential.publicKey,
          counter: Number(credential.counter),
          transports: parseTransports(credential.transports),
        },
        requireUserVerification: true,
      });
    } catch {
      return false;
    }
    if (!verification.verified) return false;
    const userHandle = response.response?.userHandle;
    if (userHandle && userHandle !== expectedUserHandle(credential)) {
      return false;
    }
    const update = {
      counter: BigInt(verification.authenticationInfo.newCounter),
      lastUsedAt: new Date(),
    };
    if (credential.table === "account") {
      await this.prisma.accountPasskey.update({
        where: { id: credential.id },
        data: update,
      });
    } else {
      await this.prisma.signingPasskey.update({
        where: { id: credential.id },
        data: update,
      });
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Registration from the account settings
  // ---------------------------------------------------------------------------

  async beginRegistration(user: User) {
    const existing = await this.credentials(user.id);
    const { rpID } = this.relyingParty();
    const options = await generateRegistrationOptions({
      rpName: (this.config.get("general.appName") as string) || "PrivCloud",
      rpID,
      userID: new TextEncoder().encode(`account:${user.id}`),
      userName: user.email,
      userDisplayName: user.username || user.email,
      timeout: PASSKEY_CEREMONY_TTL_MS,
      attestationType: "none",
      supportedAlgorithmIDs: [-7, -257],
      excludeCredentials: existing.map((credential) => ({
        id: credential.credentialId,
        transports: parseTransports(credential.transports),
      })),
      // Discoverable: the sign-in page asks for no address first.
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    });
    await this.replaceChallenges(user.id, "REGISTER");
    const challenge = await this.prisma.passkeyChallenge.create({
      data: {
        purpose: "REGISTER",
        challenge: options.challenge,
        expiresAt: new Date(Date.now() + PASSKEY_CEREMONY_TTL_MS),
        userId: user.id,
      },
      select: { id: true },
    });
    return { challengeId: challenge.id, options };
  }

  async finishRegistration(user: User, dto: PasskeyResponseDTO) {
    const challenge = await this.usableChallenge(
      dto.challengeId,
      user.id,
      "REGISTER",
    );
    const { rpID, expectedOrigin } = this.relyingParty();
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response: dto.response as unknown as RegistrationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin,
        expectedRPID: rpID,
        requireUserPresence: true,
        requireUserVerification: true,
      });
    } catch {
      throw new BadRequestException("The passkey could not be verified");
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new BadRequestException("The passkey could not be verified");
    }
    await this.consume(challenge.id);
    const info = verification.registrationInfo;
    if (await this.credentialById(info.credential.id)) {
      throw new ConflictException("This passkey is already registered");
    }
    const passkey = await this.prisma.accountPasskey.create({
      data: {
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey),
        publicKeyAlgorithm: coseAlgorithm(info.credential.publicKey),
        counter: BigInt(info.credential.counter),
        transports: info.credential.transports
          ? JSON.stringify(info.credential.transports)
          : null,
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        aaguid: info.aaguid,
        userId: user.id,
      },
      select: {
        id: true,
        createdAt: true,
        lastUsedAt: true,
        deviceType: true,
        backedUp: true,
      },
    });
    this.logger.log(`User ${user.id} registered an account passkey`);
    return passkey;
  }

  async remove(user: User, passkeyId: string) {
    const { count } = await this.prisma.accountPasskey.deleteMany({
      where: { id: passkeyId, userId: user.id },
    });
    if (count !== 1) throw new NotFoundException("Passkey not found");
    this.logger.log(`User ${user.id} removed an account passkey`);
    return { deleted: true };
  }

  // ---------------------------------------------------------------------------
  // Sign-in
  // ---------------------------------------------------------------------------

  /**
   * Options for a sign-in without an address: the browser offers the
   * passkeys it holds for this site, the answer names the account.
   */
  async beginLogin() {
    await this.prisma.passkeyChallenge.deleteMany({
      where: { purpose: "LOGIN", expiresAt: { lt: new Date() } },
    });
    const { rpID } = this.relyingParty();
    const options = await generateAuthenticationOptions({
      rpID,
      timeout: PASSKEY_CEREMONY_TTL_MS,
      userVerification: "required",
    });
    const challenge = await this.prisma.passkeyChallenge.create({
      data: {
        purpose: "LOGIN",
        challenge: options.challenge,
        expiresAt: new Date(Date.now() + PASSKEY_CEREMONY_TTL_MS),
      },
      select: { id: true },
    });
    return { challengeId: challenge.id, options };
  }

  /**
   * The account behind a sign-in assertion. Every failure is the same 401:
   * it never tells whether a passkey or an account exists.
   */
  async verifyLogin(dto: PasskeyResponseDTO): Promise<User> {
    const refused = () =>
      new UnauthorizedException("This passkey could not sign you in");
    const challenge = await this.prisma.passkeyChallenge.findFirst({
      where: {
        id: dto.challengeId,
        purpose: "LOGIN",
        userId: null,
        consumedAt: null,
      },
    });
    if (!challenge || challenge.expiresAt <= new Date()) throw refused();
    const response = dto.response as unknown as AuthenticationResponseJSON;
    const credential = await this.credentialById(response?.id);
    if (!credential) throw refused();
    const origins = [this.relyingParty().expectedOrigin];
    if (
      !(await this.verifyAssertion(
        challenge.challenge,
        credential,
        response,
        origins,
      ))
    )
      throw refused();
    try {
      await this.consume(challenge.id);
    } catch {
      throw refused();
    }
    const user = await this.prisma.user.findUnique({
      where: { id: credential.userId },
    });
    if (!user) throw refused();
    this.logger.log(`Passkey sign-in for user ${user.id}`);
    return user;
  }

  // ---------------------------------------------------------------------------
  // Approval of a copy issued to a contractor
  // ---------------------------------------------------------------------------

  /**
   * Options for an assertion by one of the user's own passkeys, user
   * verification required. Refused with `missing` when there is none.
   */
  private async beginOwnAssertion(
    user: User,
    purpose: "ISSUE" | "VAULT" | "TEAM_EVIDENCE" | "STEP_UP",
    missing: { message: string; code: string },
    ceremony: { challenge?: Uint8Array; manifest?: string; previewId?: string },
    credentials?: StoredCredential[],
  ) {
    credentials ??= await this.credentials(user.id);
    if (credentials.length === 0) {
      throw new ForbiddenException(missing.message, missing.code);
    }
    const { rpID } = this.relyingParty();
    const options = await generateAuthenticationOptions({
      rpID,
      ...(ceremony.challenge
        ? { challenge: new Uint8Array(ceremony.challenge) }
        : {}),
      timeout: PASSKEY_CEREMONY_TTL_MS,
      userVerification: "required",
      allowCredentials: credentials.map((credential) => ({
        id: credential.credentialId,
        transports: parseTransports(credential.transports),
      })),
    });
    await this.replaceChallenges(user.id, purpose, ceremony.previewId);
    const challenge = await this.prisma.passkeyChallenge.create({
      data: {
        purpose,
        challenge: options.challenge,
        manifest: ceremony.manifest,
        previewId: ceremony.previewId,
        expiresAt: new Date(Date.now() + PASSKEY_CEREMONY_TTL_MS),
        userId: user.id,
      },
      select: { id: true },
    });
    return { challengeId: challenge.id, options };
  }

  /** The challenge is the SHA-256 of the canonical manifest itself. */
  beginIssue(
    user: User,
    previewId: string,
    manifest: string,
    manifestHash: string,
  ) {
    return this.beginOwnAssertion(
      user,
      "ISSUE",
      {
        message: "Register a passkey before issuing a copy",
        code: "approval_passkey_required",
      },
      { challenge: Buffer.from(manifestHash, "hex"), manifest, previewId },
    );
  }

  async verifyIssue(
    user: User,
    previewId: string,
    dto: PasskeyResponseDTO,
  ): Promise<IssuanceAssertion> {
    const challenge = await this.usableChallenge(
      dto.challengeId,
      user.id,
      "ISSUE",
      previewId,
    );
    if (!challenge.manifest) {
      throw new BadRequestException("Passkey challenge is invalid or expired");
    }
    const response = dto.response as unknown as AuthenticationResponseJSON;
    const credential = (await this.credentials(user.id)).find(
      (stored) => stored.credentialId === response?.id,
    );
    if (!credential) throw new ForbiddenException("Unknown passkey");
    if (
      !(await this.verifyAssertion(challenge.challenge, credential, response))
    )
      throw new ForbiddenException("The passkey confirmation is invalid");
    await this.consume(challenge.id);
    return {
      manifest: challenge.manifest,
      manifestHash: Buffer.from(challenge.challenge, "base64url").toString(
        "hex",
      ),
      credentialId: credential.credentialId,
      credentialPublicKey: Buffer.from(credential.publicKey).toString(
        "base64url",
      ),
      credentialAlgorithm: coseAlgorithm(credential.publicKey),
      authenticatorData: response.response.authenticatorData,
      clientDataJSON: response.response.clientDataJSON,
      signature: response.response.signature,
      userHandle: response.response.userHandle ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Per-copy evidence downloads by team administrators
  // ---------------------------------------------------------------------------

  beginTeamEvidence(
    user: User,
    teamId: string,
    issuanceId: string,
    kind: "certificate" | "evidence" | "pattern",
  ) {
    return this.beginOwnAssertion(
      user,
      "TEAM_EVIDENCE",
      {
        message: "A passkey is required to download team evidence",
        code: "evidence_passkey_required",
      },
      {
        previewId: issuanceId,
        manifest: JSON.stringify({ teamId, issuanceId, kind }),
      },
    );
  }

  async verifyTeamEvidence(
    user: User,
    teamId: string,
    issuanceId: string,
    kind: "certificate" | "evidence" | "pattern",
    dto: PasskeyResponseDTO,
  ) {
    const challenge = await this.usableChallenge(
      dto.challengeId,
      user.id,
      "TEAM_EVIDENCE",
      issuanceId,
    );
    if (challenge.manifest !== JSON.stringify({ teamId, issuanceId, kind }))
      throw new ForbiddenException(
        "The evidence download does not match the passkey request",
      );
    const response = dto.response as unknown as AuthenticationResponseJSON;
    const credential = (await this.credentials(user.id)).find(
      (stored) => stored.credentialId === response?.id,
    );
    if (
      !credential ||
      !(await this.verifyAssertion(challenge.challenge, credential, response, [
        this.relyingParty().expectedOrigin,
      ]))
    )
      throw new ForbiddenException("The passkey confirmation is invalid");
    await this.consume(challenge.id);
  }

  // Evidence vault of the platform administrators, with a separate purpose.
  /** A random challenge: the vault opens for a fresh, verified presence. */
  beginVault(user: User) {
    return this.beginOwnAssertion(
      user,
      "VAULT",
      {
        message: "Register a passkey before opening the evidence vault",
        code: "vault_passkey_required",
      },
      {},
    );
  }

  async verifyVault(user: User, dto: PasskeyResponseDTO) {
    const challenge = await this.usableChallenge(
      dto.challengeId,
      user.id,
      "VAULT",
    );
    const response = dto.response as unknown as AuthenticationResponseJSON;
    const credential = (await this.credentials(user.id)).find(
      (stored) => stored.credentialId === response?.id,
    );
    if (
      !credential ||
      !(await this.verifyAssertion(challenge.challenge, credential, response))
    ) {
      throw new ForbiddenException("The passkey confirmation is invalid");
    }
    await this.consume(challenge.id);
  }

  /**
   * Passkeys added from the account settings only: adding one takes the
   * password or a fresh linked sign-in, which enrolling a signing passkey
   * does not.
   */
  private async accountCredentials(userId: string) {
    return (await this.credentials(userId)).filter(
      (credential) => credential.table === "account",
    );
  }

  // Platform administrators confirming one sensitive operation, named by the
  // scope the challenge is issued for.
  async beginStepUp(user: User, scope: string) {
    return this.beginOwnAssertion(
      user,
      "STEP_UP",
      {
        message: "Add a passkey from your account before confirming with one",
        code: "step_up_passkey_required",
      },
      { manifest: scope },
      await this.accountCredentials(user.id),
    );
  }

  async verifyStepUp(user: User, scope: string, dto: PasskeyResponseDTO) {
    const challenge = await this.usableChallenge(
      dto.challengeId,
      user.id,
      "STEP_UP",
    );
    if (challenge.manifest !== scope) {
      throw new ForbiddenException(
        "The passkey confirmation was started for another operation",
      );
    }
    const response = dto.response as unknown as AuthenticationResponseJSON;
    const credential = (await this.accountCredentials(user.id)).find(
      (stored) => stored.credentialId === response?.id,
    );
    if (
      !credential ||
      !(await this.verifyAssertion(challenge.challenge, credential, response))
    ) {
      throw new ForbiddenException("The passkey confirmation is invalid");
    }
    await this.consume(challenge.id);
  }

  /** Whether the user holds a passkey that can confirm an operation. */
  async hasStepUpPasskey(userId: string) {
    return (await this.accountCredentials(userId)).length > 0;
  }
}
