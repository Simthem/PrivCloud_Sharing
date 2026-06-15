import {
  IsString,
  IsIn,
  IsInt,
  IsOptional,
  IsArray,
  IsJSON,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export class RegisterIdentityKeyDTO {
  @IsIn(["X25519", "Ed25519"])
  keyType: string;

  @IsString()
  @MaxLength(256)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: "publicKey must be base64url" })
  publicKey: string;

  @IsString()
  @MaxLength(512)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: "encryptedPrivateKey must be base64url",
  })
  encryptedPrivateKey: string;

  @IsOptional()
  @IsIn(["x25519", "ed25519", "x25519-ml-kem-768"])
  algorithm?: string;
}

export class RotateIdentityKeyDTO {
  @IsIn(["X25519", "Ed25519"])
  keyType: string;

  @IsString()
  @MaxLength(256)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: "publicKey must be base64url" })
  publicKey: string;

  @IsString()
  @MaxLength(512)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: "encryptedPrivateKey must be base64url",
  })
  encryptedPrivateKey: string;

  @IsOptional()
  @IsIn(["x25519", "ed25519", "x25519-ml-kem-768"])
  algorithm?: string;
}

export class CreateAccessGrantDTO {
  @IsString()
  @MaxLength(1024)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: "encryptedFileKey must be base64url" })
  encryptedFileKey: string;

  @IsString()
  @MaxLength(256)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: "ephemeralPublicKey must be base64url" })
  ephemeralPublicKey: string;

  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: "nonce must be base64url" })
  nonce: string;

  @IsString()
  @MaxLength(128)
  recipientUserId: string;

  @IsOptional()
  @IsIn(["x25519-aes256gcm", "x25519-ml-kem-768-aes256gcm"])
  algorithm?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  fileId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  teamFileId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  shareId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8192)
  encryptedNotification?: string;
}

export class BulkCreateGrantsDTO {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateAccessGrantDTO)
  grants: CreateAccessGrantDTO[];
}

export class RevokeGrantDTO {
  @IsString()
  grantId: string;
}

export class CreateEnrollmentTokenDTO {
  @IsIn(["ONBOARDING", "TEAM_JOIN", "DEVICE_ADD"])
  purpose: string;

  @IsOptional()
  @IsString()
  teamId?: string;

  @IsOptional()
  @IsJSON()
  metadata?: string;

  // Expiry in hours (default: 48h)
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(168)
  expiresInHours?: number;
}

export class ConsumeEnrollmentTokenDTO {
  @IsString()
  token: string;

  // The user's new public key to register upon enrollment
  @IsOptional()
  @IsString()
  publicKey?: string;
}

export class RegisterPQKeyDTO {
  @IsOptional()
  @IsIn(["ML-KEM-768", "ML-KEM-1024"])
  variant?: string;

  @IsString()
  @MaxLength(4096) // ML-KEM public keys are larger than X25519
  publicKey: string;

  @IsString()
  @MaxLength(8192) // ML-KEM private keys are ~2400 bytes
  encryptedPrivateKey: string;
}
