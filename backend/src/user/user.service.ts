import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import * as argon from "argon2";
import * as crypto from "crypto";
import { Entry } from "ldapts";
import { AuthSignInDTO } from "src/auth/dto/authSignIn.dto";
import { EmailService } from "src/email/email.service";
import { EmailVerificationService } from "src/emailVerification/emailVerification.service";
import { PrismaService } from "src/prisma/prisma.service";
import { createUserUniqueConflictResponse } from "src/prisma/prisma-error.util";
import { inspect } from "util";
import { ConfigService } from "../config/config.service";
import { FileService } from "../file/file.service";
import { CreateUserDTO } from "./dto/createUser.dto";
import { UpdateUserDto } from "./dto/updateUser.dto";

@Injectable()
export class UserSevice {
  private readonly logger = new Logger(UserSevice.name);

  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
    private emailVerificationService: EmailVerificationService,
    private fileService: FileService,
    private configService: ConfigService,
  ) {}

  async list() {
    return await this.prisma.user.findMany();
  }

  async get(id: string) {
    return await this.prisma.user.findUnique({ where: { id } });
  }

  async create(dto: CreateUserDTO) {
    this.emailVerificationService.assertDeliveryAvailable();
    const verificationRequiredAt = new Date();
    let hash: string;

    // The password can be undefined if the user is invited by an admin
    if (!dto.password) {
      const randomPassword = crypto.randomUUID();
      hash = await argon.hash(randomPassword);
      await this.emailService.sendInviteEmail(dto.email, randomPassword);
    } else {
      hash = await argon.hash(dto.password);
    }

    // Strip password from the DTO so it is not passed to Prisma user create.
    const { password: _pwd, ...userData } = dto;

    try {
      const user = await this.prisma.user.create({
        data: {
          ...userData,
          password: hash,
          emailVerificationRequiredAt: verificationRequiredAt,
        },
      });

      // Auto-create team for user
      await this.autoCreateTeamForUser(user.id, user.username, user.email);

      try {
        await this.emailVerificationService.issueAndSend(user);
      } catch (error) {
        await this.prisma.user.deleteMany({ where: { id: user.id } });
        throw error;
      }

      return user;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code == "P2002") {
          throw new BadRequestException(createUserUniqueConflictResponse(e));
        }
      }
      throw e;
    }
  }

  async update(id: string, user: UpdateUserDto) {
    try {
      const current = await this.prisma.user.findUnique({ where: { id } });
      const emailChanged =
        !!current &&
        !!user.email &&
        user.email !== current.email &&
        !!current.emailVerificationRequiredAt;
      if (emailChanged) {
        this.emailVerificationService.assertDeliveryAvailable();
      }
      const hash = user.password && (await argon.hash(user.password));
      const { password: _password, ...userData } = user as Record<string, unknown>;

      const verificationData = emailChanged
        ? {
            // A still-unverified account keeps its original J+5/J+14 clock;
            // changing the address must never extend its grace period.
            emailVerificationRequiredAt: current.emailVerifiedAt
              ? new Date()
              : current.emailVerificationRequiredAt,
            emailVerifiedAt: null,
            emailVerificationDeletionStartedAt: null,
          }
        : {};

      const updated = await this.prisma.user.update({
        where: { id },
        data: {
          ...(userData as Prisma.UserUpdateInput),
          password: hash,
          ...verificationData,
        },
      });

      if (emailChanged) {
        await this.emailVerificationService.issueAndSend(updated);
      }

      return updated;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code == "P2002") {
          throw new BadRequestException(createUserUniqueConflictResponse(e));
        }
      }
      throw e;
    }
  }

  async delete(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { shares: true },
    });
    if (!user) throw new BadRequestException("User not found");

    if (user.isAdmin) {
      const userCount = await this.prisma.user.count({
        where: { isAdmin: true },
      });

      if (userCount === 1) {
        throw new BadRequestException("Cannot delete the last admin user");
      }
    }

    await Promise.all(
      user.shares.map((share) => this.fileService.deleteAllFiles(share.id)),
    );

    return await this.prisma.user.delete({ where: { id } });
  }

  // ─── E2E Encryption Key Management ──────────────────────────────

  async setEncryptionKeyHash(
    userId: string,
    keyHash: string,
    options: { explicitE2ESetup?: boolean } = {},
  ) {
    const data = {
      encryptionKeyHash: keyHash,
      e2eAutoGenerationDisabledAt: null,
    };

    if (options.explicitE2ESetup) {
      return this.prisma.user.update({ where: { id: userId }, data });
    }

    // First-use generation is compare-and-set: a concurrent tab must never
    // overwrite a key that was registered after it loaded the user profile.
    const { count } = await this.prisma.user.updateMany({
      where: {
        id: userId,
        encryptionKeyHash: null,
        e2eAutoGenerationDisabledAt: null,
      },
      data,
    });
    if (count !== 1) {
      throw new ConflictException(
        "E2E key state changed. Reload before configuring encryption.",
      );
    }
    return data;
  }

  async removeEncryptionKeyHash(userId: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        encryptionKeyHash: null,
        e2eAutoGenerationDisabledAt: new Date(),
      },
    });
  }

  // ─── Passkey Wrapped Keys (multi-device sync) ─────────────────

  async setWrappedKey(
    userId: string,
    data: { credentialId: string; wrappedKey: string; salt: string },
  ) {
    return this.prisma.wrappedKey.upsert({
      where: {
        userId_credentialId: { userId, credentialId: data.credentialId },
      },
      update: { wrappedKey: data.wrappedKey, salt: data.salt },
      create: { userId, ...data },
    });
  }

  async listWrappedKeys(userId: string) {
    return this.prisma.wrappedKey.findMany({
      where: { userId },
      select: { credentialId: true, wrappedKey: true, salt: true },
    });
  }

  async removeWrappedKey(userId: string, credentialId: string) {
    return this.prisma.wrappedKey.deleteMany({
      where: { userId, credentialId },
    });
  }

  async removeAllWrappedKeys(userId: string) {
    return this.prisma.wrappedKey.deleteMany({
      where: { userId },
    });
  }

  /** Remove Team key material sealed under a revoked personal key. */
  async removeTeamKeyMaterial(userId: string) {
    await this.prisma.teamMember.updateMany({
      where: { userId, wrappedTeamKey: { not: null } },
      data: {
        wrappedTeamKey: null,
        teamKeyVersion: 0,
        teamKeyUpdatedAt: null,
      },
    });
    await this.prisma.teamKeyRotation.updateMany({
      where: {
        startedById: userId,
        status: { in: ["PREPARING", "REENCRYPTING", "PAUSED"] },
      },
      data: {
        status: "CANCELLED",
        completedAt: new Date(),
        errorMessage: "Abandoned: the initiator revoked their personal key",
      },
    });
  }

  async verifyEncryptionKeyHash(
    userId: string,
    keyHash: string,
  ): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user?.encryptionKeyHash) return false;
    const match = user.encryptionKeyHash === keyHash;
    if (!match) {
      this.logger.debug(
        `[E2E verify] hash mismatch for user ${userId} -- ` +
          `stored: ${user.encryptionKeyHash.slice(0, 8)}… ` +
          `submitted: ${keyHash.slice(0, 8)}…`,
      );
    }
    return match;
  }

  async findOrCreateFromLDAP(
    providedCredentials: AuthSignInDTO,
    ldapEntry: Entry,
  ) {
    const fieldNameMemberOf = this.configService.get("ldap.fieldNameMemberOf");
    const fieldNameEmail = this.configService.get("ldap.fieldNameEmail");

    let isAdmin = false;
    if (fieldNameMemberOf in ldapEntry) {
      const adminGroup = this.configService.get("ldap.adminGroups");
      const entryGroups = Array.isArray(ldapEntry[fieldNameMemberOf])
        ? ldapEntry[fieldNameMemberOf]
        : [ldapEntry[fieldNameMemberOf]];
      isAdmin = entryGroups.includes(adminGroup) ?? false;
    } else {
      this.logger.warn(
        `Trying to create/update a ldap user but the member field ${fieldNameMemberOf} is not present.`,
      );
    }

    let userEmail: string | null = null;
    if (fieldNameEmail in ldapEntry) {
      const value = Array.isArray(ldapEntry[fieldNameEmail])
        ? ldapEntry[fieldNameEmail][0]
        : ldapEntry[fieldNameEmail];
      if (value) {
        userEmail = value.toString();
      }
    } else {
      this.logger.warn(
        `Trying to create/update a ldap user but the email field ${fieldNameEmail} is not present.`,
      );
    }

    if (providedCredentials.email) {
      /* if LDAP does not provides an users email address, take the user provided email address instead */
      userEmail = providedCredentials.email;
    }

    const randomId = crypto.randomUUID();
    const placeholderUsername = `ldap_user_${randomId}`;
    const placeholderEMail = `${randomId}@ldap.local`;

    try {
      const user = await this.prisma.user.upsert({
        create: {
          username: providedCredentials.username ?? placeholderUsername,
          email: userEmail ?? placeholderEMail,
          password: await argon.hash(crypto.randomUUID()),

          isAdmin,
          ldapDN: ldapEntry.dn,
          emailVerificationRequiredAt: new Date(),
          emailVerifiedAt: new Date(),
        },
        update: {
          isAdmin,
          ldapDN: ldapEntry.dn,
        },
        where: {
          ldapDN: ldapEntry.dn,
        },
      });

      if (user.username === placeholderUsername) {
        /* Give the user a human readable name if the user has been created with a placeholder username */
        await this.prisma.user
          .update({
            where: {
              id: user.id,
            },
            data: {
              username: `user_${user.id}`,
            },
          })
          .then((newUser) => {
            user.username = newUser.username;
          })
          .catch((error) => {
            this.logger.warn(
              `Failed to update users ${user.id} placeholder username: ${inspect(error)}`,
            );
          });
      }

      if (userEmail && userEmail !== user.email) {
        /* Sync users email if it has changed */
        await this.prisma.user
          .update({
            where: {
              id: user.id,
            },
            data: {
              email: userEmail,
            },
          })
          .then((newUser) => {
            this.logger.log(
              `Updated users ${user.id} email from ldap from ${user.email} to ${userEmail}.`,
            );
            user.email = newUser.email;
          })
          .catch((error) => {
            this.logger.error(
              `Failed to update users ${user.id} email to ${userEmail}: ${inspect(error)}`,
            );
          });
      }

      return user;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code == "P2002") {
          throw new BadRequestException(createUserUniqueConflictResponse(e));
        }
      }
    }
  }

  /**
   * Auto-create a team for users created by an instance admin.
   */
  private async autoCreateTeamForUser(
    userId: string,
    username: string,
    email: string,
  ): Promise<void> {
    // Check if user already has a team as owner
    const existingTeam = await this.prisma.team.findFirst({
      where: { ownerId: userId },
    });
    if (existingTeam) {
      if (!existingTeam.isActive) {
        await this.prisma.team.update({
          where: { id: existingTeam.id },
          data: { isActive: true },
        });
      }
      return;
    }

    const maxMembers = parseInt(process.env.TEAM_MAX_MEMBERS || "0", 10);
    const maxShareSize = BigInt(
      process.env.TEAM_MAX_SHARE_SIZE || "0", // 0 = no limit
    );
    const totalStorage = BigInt(
      process.env.TEAM_TOTAL_STORAGE_BYTES || "0", // 0 = no limit
    );

    // Generate slug from username
    const baseSlug = (username || email.split("@")[0])
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    let slug = `${baseSlug}-team`;

    let attempt = 0;
    while (await this.prisma.team.findUnique({ where: { slug } })) {
      attempt++;
      slug = `${baseSlug}-team-${attempt}`;
    }

    await this.prisma.team.create({
      data: {
        name: `Team of ${username || email.split("@")[0]}`,
        slug,
        ownerId: userId,
        maxMembers,
        maxShareSize,
        totalStorageLimit: totalStorage,
        members: {
          create: {
            userId,
            role: "OWNER",
            isActive: true,
          },
        },
      },
    });

    this.logger.log(`Auto-created team for user ${userId}`);
  }
}
