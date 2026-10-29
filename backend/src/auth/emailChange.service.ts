import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, randomBytes } from "crypto";
import { ConfigService } from "src/config/config.service";
import { EmailOutboxService } from "src/email/email-outbox.service";
import { PrismaService } from "src/prisma/prisma.service";
import { AuthService } from "./auth.service";
import { AuthTotpService } from "./authTotp.service";
import { EmailChangeDTO } from "./dto/emailChange.dto";
import { OAuthReauthService } from "./oauthReauth.service";
import {
  matchesSecurityState,
  sameSecurityState,
  sealSecurityState,
} from "./securityState.util";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

@Injectable()
export class EmailChangeService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private auth: AuthService,
    private factors: AuthTotpService,
    private reauthentication: OAuthReauthService,
    private outbox: EmailOutboxService,
  ) {}

  private invalidLink(): never {
    throw new BadRequestException(
      "This email-change link is invalid or expired",
    );
  }

  private async writeAccount(tx: Prisma.TransactionClient, id: string) {
    // Reserve SQLite's writer before reading state used by this transaction.
    await tx.$executeRaw`UPDATE "User" SET "id" = "id" WHERE "id" = ${id}`;
    return tx.user.findUnique({ where: { id } });
  }

  // Runs before a factor or proof is spent, and again inside the write.
  private async ensureRequestAllowed(
    db: Prisma.TransactionClient,
    userId: string,
    email: string,
  ) {
    const previous = await db.emailChangeRequest.findUnique({
      where: { userId },
    });
    if (previous && Date.now() - previous.createdAt.getTime() < 60_000)
      throw new HttpException(
        "Wait one minute before requesting another email change",
        429,
      );
    if (await db.user.findUnique({ where: { email } }))
      throw new ConflictException("This email address is unavailable");
  }

  async initiate(userId: string, dto: EmailChangeDTO, proof?: string) {
    if (!this.config.get("smtp.enabled"))
      throw new ServiceUnavailableException(
        "Email delivery is unavailable. Contact an administrator.",
      );
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!account) throw new ForbiddenException();
    if (account.ldapDN)
      throw new ForbiddenException(
        "Your email address is managed by your directory. Contact your administrator.",
      );
    if (account.email === dto.email)
      throw new BadRequestException("This is already your email address");

    let useOAuth = false;
    if (dto.password) {
      if (!(await this.auth.verifyPassword(account, dto.password)))
        throw new ForbiddenException("Invalid password");
    } else if (
      proof &&
      (await this.reauthentication.hasProof(proof, userId, "EMAIL")) &&
      (await this.prisma.oAuthUser.count({ where: { userId } }))
    ) {
      useOAuth = true;
    } else if (account.password) {
      throw new ForbiddenException(
        "Confirm your current password or sign in again with your linked account",
      );
    }
    // Never proven, the current address protects nothing and may belong to a
    // stranger after a typo: once a factor is proven, the new mailbox suffices.
    const newMailboxOnly =
      (!!dto.password || useOAuth) &&
      !!account.emailVerificationRequiredAt &&
      !account.emailVerifiedAt;
    await this.ensureRequestAllowed(this.prisma, userId, dto.email);
    await this.factors.confirmEmailChangeFactor(account, dto.code);
    if (
      useOAuth &&
      !(await this.reauthentication.consumeProof(proof, userId, "EMAIL"))
    )
      throw new ForbiddenException("Sign in again with your linked account");

    const approve = randomBytes(32).toString("base64url");
    const verify = randomBytes(32).toString("base64url");
    const cancel = randomBytes(32).toString("base64url");
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 1_800_000);
    const securityState = await sealSecurityState(account);
    const fragmentLink = (token: string, action = "confirm") =>
      `${this.config.get("general.appUrl")}/auth/change-email#action=${action}&token=${token}`;
    await this.conflictSafe(async () =>
      this.prisma.$transaction(async (tx) => {
        const current = await this.writeAccount(tx, userId);
        if (
          !current ||
          current.email !== account.email ||
          !sameSecurityState(current, account)
        )
          throw new ConflictException("Account security changed. Start again.");
        await this.ensureRequestAllowed(tx, userId, dto.email);
        const values = {
          oldEmail: current.email,
          newEmail: dto.email,
          securityState,
          oldTokenHash: digest(approve),
          newTokenHash: digest(verify),
          cancelTokenHash: digest(cancel),
          createdAt,
          expiresAt,
          oldApprovedAt: newMailboxOnly ? createdAt : null,
          newVerifiedAt: null,
          consumedAt: null,
        };
        const pending = await tx.emailChangeRequest.upsert({
          where: { userId },
          create: { userId, ...values },
          update: values,
        });
        if (!newMailboxOnly)
          await this.outbox.enqueue(
            tx,
            {
              recipient: current.email,
              subject: "Approve your email address change",
              text: `A change of your account email to ${dto.email} was requested.\n\nIf you requested this, open this link and explicitly approve:\n${fragmentLink(approve)}\n\nCancel this request:\n${fragmentLink(cancel, "cancel")}\n\nBoth addresses must approve within 30 minutes. Your current address remains active until completion.`,
              expiresAt: expiresAt.toISOString(),
            },
            `email-change-old:${pending.id}:${digest(approve)}`,
          );
        await this.outbox.enqueue(
          tx,
          {
            recipient: dto.email,
            subject: "Confirm your new email address",
            text: `Open this link and explicitly confirm your new email address:\n${fragmentLink(verify)}\n\n${newMailboxOnly ? "The link expires in 30 minutes." : "The current address must also approve within 30 minutes."} If you did not request this, ignore this message.`,
            expiresAt: expiresAt.toISOString(),
          },
          `email-change-new:${pending.id}:${digest(verify)}`,
        );
      }),
    );
    void this.outbox.deliverPending().catch(() => undefined);
    return { pending: true, currentAddressApproval: !newMailboxOnly };
  }

  confirm(token: string) {
    return this.redeem(token, false);
  }

  async cancel(token: string) {
    await this.redeem(token, true);
    return { cancelled: true };
  }

  private async redeem(token: string, cancellation: boolean) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) this.invalidLink();
    const tokenHash = digest(token);
    const lookup = cancellation
      ? { cancelTokenHash: tokenHash }
      : { OR: [{ oldTokenHash: tokenHash }, { newTokenHash: tokenHash }] };
    const found = await this.prisma.emailChangeRequest.findFirst({
      where: lookup,
    });
    if (!found) this.invalidLink();
    return this.conflictSafe(async () =>
      this.prisma.$transaction(async (tx) => {
        const account = await this.writeAccount(tx, found.userId);
        const pending = await tx.emailChangeRequest.findUnique({
          where: { userId: found.userId },
        });
        if (
          !account ||
          !pending ||
          pending.consumedAt ||
          pending.expiresAt.getTime() <= Date.now() ||
          pending.oldEmail !== account.email ||
          // An account already being purged for an unproven address stays so.
          account.emailVerificationDeletionStartedAt ||
          !(await matchesSecurityState(pending.securityState, account))
        )
          this.invalidLink();
        const isOld = tokenHash === pending.oldTokenHash;
        const isNew = tokenHash === pending.newTokenHash;
        if (
          cancellation
            ? tokenHash !== pending.cancelTokenHash
            : !isOld && !isNew
        )
          this.invalidLink();
        const now = new Date();
        if (cancellation) {
          await tx.emailChangeRequest.update({
            where: { userId: account.id },
            data: { consumedAt: now },
          });
          return { changed: false };
        }
        if (isOld ? !!pending.oldApprovedAt : !!pending.newVerifiedAt)
          this.invalidLink();
        const changed = isOld
          ? !!pending.newVerifiedAt
          : !!pending.oldApprovedAt;
        await tx.emailChangeRequest.update({
          where: { userId: account.id },
          data: {
            ...(isOld ? { oldApprovedAt: now } : { newVerifiedAt: now }),
            ...(changed ? { consumedAt: now } : {}),
          },
        });
        if (changed) {
          await tx.user.update({
            where: { id: account.id },
            data: {
              email: pending.newEmail,
              emailVerifiedAt: now,
              emailVerificationSource: "EMAIL_LINK",
              emailVerificationDeletionStartedAt: null,
            },
          });
          await tx.resetPasswordToken.deleteMany({
            where: { userId: account.id },
          });
          await tx.emailVerificationToken.deleteMany({
            where: { userId: account.id },
          });
        }
        return { changed };
      }),
    );
  }

  private async conflictSafe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new ConflictException("This email address is unavailable");
      throw error;
    }
  }
}
