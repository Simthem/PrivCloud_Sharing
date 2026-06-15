import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { GetUser } from "src/auth/decorator/getUser.decorator";
import { User } from "@prisma/client";
import { CryptoIdentityService } from "./identity.service";
import {
  RegisterIdentityKeyDTO,
  RotateIdentityKeyDTO,
  RegisterPQKeyDTO,
} from "./dto/crypto.dto";

@Controller("crypto/identity")
export class CryptoIdentityController {
  constructor(private identityService: CryptoIdentityService) {}

  /**
   * Register a new identity key pair (X25519 or Ed25519).
   * Called during initial account setup or first E2E activation.
   */
  @Post("keys")
  @UseGuards(JwtGuard)
  @Throttle({ default: { ttl: 3600, limit: 10 } })
  async registerKey(@GetUser() user: User, @Body() dto: RegisterIdentityKeyDTO) {
    return this.identityService.registerKey(user.id, dto);
  }

  /**
   * Get my own keys (including encrypted private keys for device sync).
   */
  @Get("keys/me")
  @UseGuards(JwtGuard)
  async getMyKeys(@GetUser() user: User) {
    return this.identityService.getMyKeys(user.id);
  }

  /**
   * Get a user's public keys (for creating grants).
   * Public endpoint: any authenticated user can look up another's public keys.
   */
  @Get("keys/user/:userId")
  @UseGuards(JwtGuard)
  async getPublicKeys(@Param("userId") userId: string) {
    return this.identityService.getPublicKeys(userId);
  }

  /**
   * Batch lookup public keys for multiple users.
   * Used when sharing a file with multiple team members.
   */
  @Post("keys/batch")
  @UseGuards(JwtGuard)
  @Throttle({ default: { ttl: 60, limit: 30 } })
  async getPublicKeysForUsers(@Body() body: { userIds: string[] }) {
    return this.identityService.getPublicKeysForUsers(body.userIds);
  }

  /**
   * Rotate an identity key. Deactivates the old one, registers the new one.
   * Old grants remain decryptable with the old key (kept in history).
   */
  @Put("keys/rotate")
  @UseGuards(JwtGuard)
  @Throttle({ default: { ttl: 3600, limit: 5 } })
  async rotateKey(@GetUser() user: User, @Body() dto: RotateIdentityKeyDTO) {
    return this.identityService.rotateKey(user.id, dto);
  }

  /**
   * Register a post-quantum key (ML-KEM) for hybrid mode.
   * Enables PQ-resistant key encapsulation alongside X25519.
   */
  @Post("pq-keys")
  @UseGuards(JwtGuard)
  @Throttle({ default: { ttl: 3600, limit: 5 } })
  async registerPQKey(@GetUser() user: User, @Body() dto: RegisterPQKeyDTO) {
    return this.identityService.registerPQKey(user.id, dto);
  }

  /**
   * Get a user's PQ public key (for hybrid grants).
   */
  @Get("pq-keys/user/:userId")
  @UseGuards(JwtGuard)
  async getPQPublicKey(@Param("userId") userId: string) {
    return this.identityService.getPQPublicKey(userId);
  }

  /**
   * Get my own PQ key (including encrypted private key for decryption).
   * Needed for decrypting E2E-encrypted notifications.
   */
  @Get("pq-keys/me")
  @UseGuards(JwtGuard)
  async getMyPQKey(@GetUser() user: User) {
    return this.identityService.getMyPQKey(user.id);
  }
}
