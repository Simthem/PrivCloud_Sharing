import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "src/prisma/prisma.service";
import {
  RewrapIdentityKeysDTO,
  RegisterIdentityKeyDTO,
  RotateIdentityKeyDTO,
  RegisterPQKeyDTO,
} from "./dto/crypto.dto";

@Injectable()
export class CryptoIdentityService {
  private readonly logger = new Logger(CryptoIdentityService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Register a new identity key pair for a user.
   * The private key MUST be encrypted client-side before submission.
   * The server stores only the encrypted private key and the public key.
   */
  async registerKey(userId: string, dto: RegisterIdentityKeyDTO) {
    // Check for existing active key of this type
    const existingActive = await this.prisma.userIdentityKey.findFirst({
      where: { userId, keyType: dto.keyType, isActive: true },
    });

    if (existingActive) {
      throw new ConflictException(
        `Active ${dto.keyType} key already exists. Use rotation endpoint to replace it.`,
      );
    }

    // Determine next version
    const maxVersion = await this.prisma.userIdentityKey.aggregate({
      where: { userId, keyType: dto.keyType },
      _max: { version: true },
    });
    const nextVersion = (maxVersion._max.version || 0) + 1;

    const key = await this.prisma.userIdentityKey.create({
      data: {
        userId,
        keyType: dto.keyType,
        publicKey: dto.publicKey,
        encryptedPrivateKey: dto.encryptedPrivateKey,
        algorithm: dto.algorithm || dto.keyType.toLowerCase(),
        version: nextVersion,
        isActive: true,
      },
    });

    this.logger.log(
      `Identity key registered: ${dto.keyType} v${nextVersion} for user ${userId}`,
    );

    return {
      id: key.id,
      keyType: key.keyType,
      publicKey: key.publicKey,
      algorithm: key.algorithm,
      version: key.version,
    };
  }

  /**
   * Get the active public key(s) for a user.
   * This is the information other users need to create grants.
   */
  async getPublicKeys(userId: string) {
    const keys = await this.prisma.userIdentityKey.findMany({
      where: { userId, isActive: true },
      select: {
        id: true,
        keyType: true,
        publicKey: true,
        algorithm: true,
        version: true,
      },
    });

    return keys;
  }

  /**
   * Get the user's own encrypted private keys (for key recovery / device sync).
   * Only the owning user should call this.
   */
  async getMyKeys(userId: string) {
    const keys = await this.prisma.userIdentityKey.findMany({
      where: { userId, isActive: true },
      select: {
        id: true,
        keyType: true,
        publicKey: true,
        encryptedPrivateKey: true,
        algorithm: true,
        version: true,
      },
    });

    return keys;
  }

  /**
   * Rotate a key: deactivate the current active key and register a new one.
   * The old key is kept for historical grant decryption but marked inactive.
   */
  async rotateKey(userId: string, dto: RotateIdentityKeyDTO) {
    const existingActive = await this.prisma.userIdentityKey.findFirst({
      where: { userId, keyType: dto.keyType, isActive: true },
    });

    if (!existingActive) {
      throw new NotFoundException(
        `No active ${dto.keyType} key to rotate. Register one first.`,
      );
    }

    // Determine next version
    const maxVersion = await this.prisma.userIdentityKey.aggregate({
      where: { userId, keyType: dto.keyType },
      _max: { version: true },
    });
    const nextVersion = (maxVersion._max.version || 0) + 1;

    // Atomic: deactivate old + create new
    const [, newKey] = await this.prisma.$transaction([
      this.prisma.userIdentityKey.update({
        where: { id: existingActive.id },
        data: { isActive: false },
      }),
      this.prisma.userIdentityKey.create({
        data: {
          userId,
          keyType: dto.keyType,
          publicKey: dto.publicKey,
          encryptedPrivateKey: dto.encryptedPrivateKey,
          algorithm: dto.algorithm || dto.keyType.toLowerCase(),
          version: nextVersion,
          isActive: true,
        },
      }),
    ]);

    this.logger.log(
      `Identity key rotated: ${dto.keyType} v${existingActive.version} -> v${nextVersion} for user ${userId}`,
    );

    return {
      id: newKey.id,
      keyType: newKey.keyType,
      publicKey: newKey.publicKey,
      algorithm: newKey.algorithm,
      version: newKey.version,
      previousVersion: existingActive.version,
    };
  }

  /**
   * Register a post-quantum key (ML-KEM) alongside the classical key.
   * Enables hybrid mode for future-proofing against quantum attacks.
   */
  async registerPQKey(userId: string, dto: RegisterPQKeyDTO) {
    const existing = await this.prisma.userPQKey.findFirst({
      where: { userId, isActive: true },
    });

    if (existing) {
      throw new ConflictException(
        "Active PQ key already exists. Rotate it instead.",
      );
    }

    const maxVersion = await this.prisma.userPQKey.aggregate({
      where: { userId },
      _max: { version: true },
    });
    const nextVersion = (maxVersion._max.version || 0) + 1;

    const key = await this.prisma.userPQKey.create({
      data: {
        userId,
        variant: dto.variant || "ML-KEM-768",
        publicKey: dto.publicKey,
        encryptedPrivateKey: dto.encryptedPrivateKey,
        version: nextVersion,
        isActive: true,
      },
    });

    this.logger.log(
      `PQ key registered: ${key.variant} v${nextVersion} for user ${userId}`,
    );

    return {
      id: key.id,
      variant: key.variant,
      publicKey: key.publicKey,
      version: key.version,
    };
  }

  async rotatePQKey(userId: string, dto: RegisterPQKeyDTO) {
    const existing = await this.prisma.userPQKey.findFirst({
      where: { userId, isActive: true },
    });
    if (!existing) {
      throw new NotFoundException("No active PQ key to rotate.");
    }
    const [, key] = await this.prisma.$transaction([
      this.prisma.userPQKey.update({
        where: { id: existing.id },
        data: { isActive: false },
      }),
      this.prisma.userPQKey.create({
        data: {
          userId,
          variant: dto.variant || existing.variant,
          publicKey: dto.publicKey,
          encryptedPrivateKey: dto.encryptedPrivateKey,
          version: existing.version + 1,
          isActive: true,
        },
      }),
    ]);
    return {
      id: key.id,
      variant: key.variant,
      publicKey: key.publicKey,
      version: key.version,
    };
  }

  /** Same keys, wrapped again after the owner changed their E2E key. */
  async rewrapKeys(userId: string, dto: RewrapIdentityKeysDTO) {
    await this.prisma.$transaction([
      ...dto.keys.map((key) =>
        this.prisma.userIdentityKey.updateMany({
          where: { id: key.id, userId, isActive: true },
          data: { encryptedPrivateKey: key.encryptedPrivateKey },
        }),
      ),
      ...(dto.pqKey
        ? [
            this.prisma.userPQKey.updateMany({
              where: { id: dto.pqKey.id, userId, isActive: true },
              data: { encryptedPrivateKey: dto.pqKey.encryptedPrivateKey },
            }),
          ]
        : []),
    ]);
  }

  /**
   * Get PQ public key for a user (needed for hybrid grants).
   */
  async getPQPublicKey(userId: string) {
    const key = await this.prisma.userPQKey.findFirst({
      where: { userId, isActive: true },
      select: {
        id: true,
        variant: true,
        publicKey: true,
        version: true,
      },
    });

    return key;
  }

  /**
   * Get user's own PQ key including encrypted private key (for notification decryption).
   */
  async getMyPQKey(userId: string) {
    const key = await this.prisma.userPQKey.findFirst({
      where: { userId, isActive: true },
      select: {
        id: true,
        variant: true,
        publicKey: true,
        encryptedPrivateKey: true,
        version: true,
      },
    });

    return key;
  }

  /**
   * Lookup public keys for multiple users (batch - used during share/grant creation).
   */
  async getPublicKeysForUsers(userIds: string[]) {
    if (userIds.length === 0) return [];
    if (userIds.length > 100) {
      throw new BadRequestException(
        "Cannot lookup more than 100 users at once",
      );
    }

    const keys = await this.prisma.userIdentityKey.findMany({
      where: {
        userId: { in: userIds },
        isActive: true,
        keyType: "X25519", // Only exchange keys for grants
      },
      select: {
        userId: true,
        publicKey: true,
        algorithm: true,
        version: true,
      },
    });

    // Also fetch PQ keys if available
    const pqKeys = await this.prisma.userPQKey.findMany({
      where: {
        userId: { in: userIds },
        isActive: true,
      },
      select: {
        userId: true,
        publicKey: true,
        variant: true,
        version: true,
      },
    });

    // Group by user
    const result = userIds.map((uid) => ({
      userId: uid,
      x25519: keys.find((k) => k.userId === uid) || null,
      pqKey: pqKeys.find((k) => k.userId === uid) || null,
    }));

    return result;
  }
}
