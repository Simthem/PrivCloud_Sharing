import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export class CreateReverseShareDTO {
  @Length(3, 90)
  @IsOptional()
  name: string;

  @IsBoolean()
  sendEmailNotification: boolean;

  @IsString()
  maxShareSize: string;

  @IsString()
  shareExpiration: string;

  @Min(1)
  @Max(1000)
  maxUseCount: number;

  @IsBoolean()
  simplified: boolean;

  @IsBoolean()
  publicAccess: boolean;

   // E2E: K_rs encrypted by the owner's master key (base64url)
  @IsOptional()
  @IsString()
  encryptedReverseShareKey?: string;

  // Name encrypted with K_rs (base64url), sent instead of `name`.
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: "encryptedName must be base64url" })
  encryptedName?: string;
}
